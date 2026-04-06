/**
 * FrogGame AI Agent Server
 * 
 * Core game server with AI strategy analysis, OnchainOS integration,
 * and natural language chat for the OKX Build X AI Hackathon.
 * 
 * Based on the original FrogGame db-serverV2.js, cleaned up and enhanced with:
 * - AI strategy analysis endpoints
 * - OnchainOS wallet/DEX/data API integration
 * - Natural language game advisor
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { ethers } = require('ethers');
const crypto = require('crypto');
const path = require('path');

const AIAgent = require('./ai-agent');
const OnchainOS = require('./onchainos');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ============ Configuration ============
const CONFIG = {
    PRIVATE_KEY: process.env.SERVER_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
    RPC_URL: process.env.RPC_URL || 'https://rpc.xlayer.tech',
    CHAIN_ID: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 196,
    GAME_CONTRACT: process.env.GAME_CONTRACT_ADDRESS || '',
    TOKEN_ADDRESS: process.env.OEOE_TOKEN || '',
    OEOE_DECIMALS: 9,
    ROUND_DURATION: process.env.ROUND_DURATION ? parseInt(process.env.ROUND_DURATION) : 60,
    PORT: process.env.PORT || 3001,
    HOST: process.env.HOST || '0.0.0.0',
    ONCHAINOS_API_KEY: process.env.ONCHAINOS_API_KEY || '',
    ONCHAINOS_WALLET: process.env.ONCHAINOS_WALLET || ''
};

// ============ Logging ============
function logInfo(msg) {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    console.log(`[${ts}] ${msg}`);
}

function logError(msg, err) {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    console.error(`[${ts}] ${msg}`, err?.message || err || '');
}

function formatAddr(addr) {
    if (!addr) return 'unknown';
    const a = addr.toLowerCase();
    return `${a.slice(0, 7)}...${a.slice(-5)}`;
}

// ============ Database (PostgreSQL adapter) ============
const { createAdapter } = require(path.join(__dirname, '..', '..', '..', 'new-oeoe-game', 'db-adapter'));
const dbAdapter = createAdapter();

// DB shim for callback-style access
const db = {
    run(sql, params, callback) {
        if (typeof params === 'function') { callback = params; params = []; }
        dbAdapter.run(sql, params).then(result => {
            if (callback) callback.call({ changes: result?.rowCount || 0 }, null);
        }).catch(err => { if (callback) callback(err); });
    },
    get(sql, params, callback) {
        if (typeof params === 'function') { callback = params; params = []; }
        dbAdapter.get(sql, params).then(row => {
            if (callback) callback(null, row || undefined);
        }).catch(err => { if (callback) callback(err); });
    },
    all(sql, params, callback) {
        if (typeof params === 'function') { callback = params; params = []; }
        dbAdapter.all(sql, params).then(rows => {
            if (callback) callback(null, rows || []);
        }).catch(err => { if (callback) callback(err); });
    },
    serialize(fn) { fn(); },
    close(callback) {
        dbAdapter.close().then(() => { if (callback) callback(null); })
            .catch(err => { if (callback) callback(err); });
    }
};

// ============ Contract ABI ============
const CONTRACT_ABI = [
    "function playerBalances(address) view returns (uint256)",
    "function currentRoundId() view returns (uint256)",
    "function settleRound(uint256 roundId, bytes32 roundHash, bytes serverSignature, address[] losers, uint256[] loserAmounts, address[] winners, uint256[] rewards)",
    "function deposit(uint256 amount)",
    "function withdraw(uint256 amount)",
    "function getContractBalance() view returns (uint256)"
];

// ============ In-memory game data ============
const gameData = {
    bets: new Map() // roundId -> array of bets
};

function recordBet(roundId, player, foodIndex, amount) {
    if (!gameData.bets.has(roundId)) gameData.bets.set(roundId, []);
    const bet = { player: player.toLowerCase(), foodIndex, amount, settled: false, reward: 0, timestamp: Date.now() };
    gameData.bets.get(roundId).push(bet);
    return bet;
}

function getRoundBets(roundId) {
    return gameData.bets.get(roundId) || [];
}

function getCurrentPool(roundId) {
    const bets = getRoundBets(roundId);
    const totalWei = bets.reduce((sum, b) => sum + (typeof b.amount === 'bigint' ? b.amount : BigInt(b.amount || 0)), 0n);
    return Number(totalWei) / 1e9;
}

// ============ Game State ============
const gameState = {
    roundId: 0,
    startTime: 0,
    endTime: 0,
    state: 'IDLE',
    phase: 'IDLE',
    winningFood: null,
    settleTimerId: null,
    isSettling: false,
    isStartingNewRound: false,
    lastSettlement: null,
    cachedChainRoundId: null
};

// ============ WebSocket ============
const wsClients = new Set();
const wsConnections = new Map();

// ============ Balance helpers ============
function dbGetPlayerBalance(address) {
    return new Promise((resolve, reject) => {
        const addr = address.toLowerCase();
        db.get(`SELECT balance FROM player_balances WHERE address = ?`, [addr], (err, row) => {
            if (err) return reject(err);
            resolve(row && row.balance != null ? BigInt(row.balance) : 0n);
        });
    });
}

function dbAddPlayerBalance(address, amountWei) {
    return new Promise((resolve, reject) => {
        const addr = address.toLowerCase();
        const amt = typeof amountWei === 'bigint' ? amountWei.toString() : String(amountWei);
        db.run(`
            INSERT INTO player_balances (address, balance, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(address) DO UPDATE SET balance = player_balances.balance + EXCLUDED.balance, updated_at = EXCLUDED.updated_at
        `, [addr, amt, Date.now()], function(err) {
            if (err) reject(err); else resolve();
        });
    });
}

function dbSetPlayerBalance(address, balance) {
    return new Promise((resolve, reject) => {
        const addr = address.toLowerCase();
        db.run(`
            INSERT INTO player_balances (address, balance, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(address) DO UPDATE SET balance = EXCLUDED.balance, updated_at = EXCLUDED.updated_at
        `, [addr, balance, Date.now()], function(err) {
            if (err) reject(err); else resolve();
        });
    });
}

// Atomic bet: deduct balance + insert bet in transaction
function dbPlaceBetAtomic({ roundId, player, foodIndex, amountWei }) {
    const addr = player.toLowerCase();
    const amountStr = typeof amountWei === 'bigint' ? amountWei.toString() : String(amountWei);
    return dbAdapter.transaction(async (tx) => {
        const row = await tx.get(`SELECT balance FROM player_balances WHERE address = $1`, [addr]);
        const current = row && row.balance != null ? BigInt(row.balance) : 0n;
        if (current < BigInt(amountStr)) throw new Error('Insufficient balance');
        const res = await tx.run(`UPDATE player_balances SET balance = player_balances.balance - $1, updated_at = $2 WHERE address = $3 AND player_balances.balance >= $4`, [amountStr, Date.now(), addr, amountStr]);
        if (res.changes === 0) throw new Error('Insufficient balance (concurrent)');
        await tx.run(`INSERT INTO bets (round_id, player, food_index, amount, timestamp) VALUES ($1, $2, $3, $4, $5)`, [roundId, addr, foodIndex, amountStr, Date.now()]);
        return { ok: true };
    });
}

// ============ Session management ============
function dbCreateSession(address, ip, ua) {
    return new Promise((resolve, reject) => {
        const addr = address.toLowerCase();
        const token = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        db.run(`INSERT INTO online_sessions (address, session_token, login_time, last_active, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(address) DO UPDATE SET session_token = EXCLUDED.session_token, login_time = EXCLUDED.login_time, last_active = EXCLUDED.last_active, ip_address = EXCLUDED.ip_address, user_agent = EXCLUDED.user_agent`,
            [addr, token, now, now, ip, ua], function(err) { if (err) reject(err); else resolve(token); });
    });
}

function dbValidateSession(address, token) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT session_token FROM online_sessions WHERE address = ? AND session_token = ?`,
            [address.toLowerCase(), token], (err, row) => { if (err) reject(err); else resolve(!!row); });
    });
}

// ============ Leaderboard helpers ============
function dbUpdateLeaderboard(player, betAmount, profit) {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO leaderboard (address, total_invested, total_profit, total_bets, last_updated) VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(address) DO UPDATE SET total_invested = leaderboard.total_invested + EXCLUDED.total_invested, total_profit = leaderboard.total_profit + EXCLUDED.total_profit, total_bets = leaderboard.total_bets + 1, last_updated = EXCLUDED.last_updated`,
            [player.toLowerCase(), betAmount, profit, Date.now()], function(err) { if (err) reject(err); else resolve(); });
    });
}

// ============ History helpers ============
function dbAddPlayerHistory(player, record) {
    return new Promise((resolve, reject) => {
        const addr = player.toLowerCase();
        db.run(`INSERT INTO history (address, round_id, time, eaten_food, eaten_emoji, user_food, user_emoji, bet_amount, total_pool, is_win, profit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [addr, record.roundId || 0, record.time, record.eatenFood, record.eatenEmoji || '', record.userFood, record.userEmoji || '', record.userBetAmount, record.totalPool || 0, record.isWin ? true : false, record.amount, Date.now()],
            function(err) { if (err) reject(err); else resolve(); });
    });
}

function dbGetPlayerHistory(address, limit = 50) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT round_id as "roundId", time, eaten_food as "eatenFood", eaten_emoji as "eatenEmoji", user_food as "userFood", user_emoji as "userEmoji", bet_amount as "userBetAmount", total_pool as "totalPool", is_win as "isWin", profit as amount FROM history WHERE address = ? ORDER BY created_at DESC LIMIT ?`,
            [address.toLowerCase(), limit], (err, rows) => { if (err) reject(err); else resolve(rows || []); });
    });
}

// ============ Damage Reduction (rank-based) ============
function getDamageReductionRate(rank) {
    const r = Number(rank);
    if (r === 0) return 0.10;
    if (r >= 1 && r <= 4) return 0.05;
    if (r >= 5 && r <= 9) return 0.03;
    return 0;
}

function dbGetPlayerLastDayRank(address) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT rank FROM (SELECT address, ROW_NUMBER() OVER (ORDER BY hourly_invested DESC) - 1 as rank FROM last_hour_leaderboard) AS ranked WHERE address = ?`,
            [address.toLowerCase()], (err, row) => { if (err) reject(err); else resolve(row ? Number(row.rank) : -1); });
    });
}

// ============ Server Class ============
class FrogGameAIServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server });

        this.provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL, CONFIG.CHAIN_ID);
        this.wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, this.provider);
        this.contract = new ethers.Contract(CONFIG.GAME_CONTRACT, CONTRACT_ABI, this.wallet);

        const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)"];
        this.tokenContract = new ethers.Contract(CONFIG.TOKEN_ADDRESS, TOKEN_ABI, this.wallet);

        this.serverAddress = this.wallet.address;

        // Initialize OnchainOS
        this.onchainos = new OnchainOS({
            apiKey: CONFIG.ONCHAINOS_API_KEY,
            walletAddress: CONFIG.ONCHAINOS_WALLET
        });

        // Initialize AI Agent
        this.aiAgent = new AIAgent({
            getRoundBets: (rid) => getRoundBets(rid || gameState.roundId),
            getGameState: () => this.getGameState(),
            db,
            onchainos: this.onchainos,
            config: CONFIG
        });

        this.setupMiddleware();
        this.setupGameRoutes();
        this.setupAIRoutes();
        this.setupWebSocket();

        logInfo('FrogGame AI Agent Server initialized');
        logInfo(`Server address: ${this.serverAddress}`);
    }

    setupMiddleware() {
        this.app.use((req, res, next) => { res.charset = 'utf-8'; next(); });
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, '..', 'public')));

        // Rate limiting for write endpoints
        const writeCounts = new Map();
        const WRITE_PATHS = new Set(['/api/bet', '/api/login', '/api/sync-balance', '/api/withdraw', '/api/deposit']);
        this.app.use((req, res, next) => {
            if (WRITE_PATHS.has(req.path) && req.method === 'POST') {
                const ip = req.ip || 'unknown';
                const now = Date.now();
                const entry = writeCounts.get(ip);
                if (!entry || now > entry.resetAt) {
                    writeCounts.set(ip, { count: 1, resetAt: now + 10000 });
                } else {
                    entry.count++;
                    if (entry.count > 20) return res.status(429).json({ error: 'Too many requests' });
                }
            }
            next();
        });
    }

    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            wsClients.add(ws);
            ws.on('close', () => wsClients.delete(ws));
            ws.on('error', () => wsClients.delete(ws));
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.type === 'login' && msg.address) {
                        if (msg.token) {
                            dbValidateSession(msg.address, msg.token).then(valid => {
                                if (valid) {
                                    wsConnections.set(msg.address.toLowerCase(), ws);
                                    ws.address = msg.address;
                                }
                            });
                        } else {
                            ws.address = msg.address;
                        }
                    }
                } catch (e) {}
            });
        });
    }

    broadcast(type, data) {
        const msg = JSON.stringify({ type, data: { ...data, phase: data?.phase || gameState.phase } });
        wsClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    }

    getGameState() {
        const now = Math.floor(Date.now() / 1000);
        const timeLeft = Math.max(0, (gameState.endTime || 0) - now);
        const ls = gameState.lastSettlement || {};
        return {
            roundId: Math.max(gameState.roundId || 0, 1),
            state: gameState.state,
            phase: gameState.phase || gameState.state,
            timeLeft,
            totalPool: ls.totalPool || getCurrentPool(gameState.roundId),
            winningFood: gameState.winningFood,
            rewardPool: ls.rewardPool || 0,
            winnerTotal: ls.winnerTotal || 0,
            losingPool: ls.losingPool || 0,
            isNoContest: ls.isNoContest || false,
            loserReductions: ls.loserReductions || []
        };
    }

    getFoodBets(roundId) {
        const bets = getRoundBets(roundId);
        const foodBets = [0, 0, 0, 0, 0, 0, 0, 0];
        bets.forEach(bet => {
            const w = typeof bet.amount === 'bigint' ? bet.amount : BigInt(bet.amount || 0);
            foodBets[bet.foodIndex] += Math.floor(Number(w) / 1e9);
        });
        return foodBets;
    }

    // ==================== AI API Routes ====================
    setupAIRoutes() {
        // AI Strategy Analysis — current round
        this.app.get('/api/ai/strategy', async (req, res) => {
            try {
                const result = await this.aiAgent.analyzeStrategy(gameState.roundId);
                res.json(result);
            } catch (err) {
                logError('AI strategy error', err);
                res.status(500).json({ error: err.message });
            }
        });

        // AI History Analysis
        this.app.get('/api/ai/history-analysis', async (req, res) => {
            try {
                const result = await this.aiAgent.analyzeHistory();
                res.json(result);
            } catch (err) {
                logError('AI history error', err);
                res.status(500).json({ error: err.message });
            }
        });

        // AI Risk Assessment for a player
        this.app.get('/api/ai/risk-assessment/:address', async (req, res) => {
            try {
                const result = await this.aiAgent.assessRisk(req.params.address);
                res.json(result);
            } catch (err) {
                logError('AI risk error', err);
                res.status(500).json({ error: err.message });
            }
        });

        // AI Chat — natural language interaction
        this.app.post('/api/ai/chat', async (req, res) => {
            try {
                const { message, address } = req.body;
                const result = await this.aiAgent.chat(message, address);
                res.json(result);
            } catch (err) {
                logError('AI chat error', err);
                res.status(500).json({ error: err.message });
            }
        });

        // OnchainOS endpoints
        this.app.get('/api/onchainos/wallet-balance', async (req, res) => {
            try {
                const addr = req.query.address || CONFIG.ONCHAINOS_WALLET;
                const data = await this.onchainos.getWalletBalance(addr);
                res.json({ address: addr, balances: data });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        this.app.get('/api/onchainos/token-price', async (req, res) => {
            try {
                const tokenAddr = req.query.token || CONFIG.TOKEN_ADDRESS;
                const data = await this.onchainos.getTokenPrice(tokenAddr);
                res.json(data);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        this.app.get('/api/onchainos/market-overview', async (req, res) => {
            try {
                const tokenAddr = req.query.token || CONFIG.TOKEN_ADDRESS;
                const data = await this.onchainos.getMarketOverview(tokenAddr);
                res.json(data);
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
    }

    // ==================== Core Game Routes ====================
    setupGameRoutes() {
        // Game state
        this.app.get('/api/game-state', (req, res) => {
            res.json(this.getGameState());
        });

        // Round bets
        this.app.get('/api/round-bets', (req, res) => {
            res.json({ roundId: gameState.roundId, foodBets: this.getFoodBets(gameState.roundId) });
        });

        // Place bet
        this.app.post('/api/bet', async (req, res) => {
            try {
                const { player, foodIndex, amount, nonce } = req.body;
                if (!player) return res.status(400).json({ error: 'Missing player' });
                const addr = player.toLowerCase();
                const fi = Number(foodIndex);
                const amt = Number(amount);
                if (fi < 0 || fi > 7) return res.status(400).json({ error: 'Invalid food index' });
                if (!amt || isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });
                if (gameState.state !== 'BETTING') return res.status(400).json({ error: 'Not in betting phase' });

                const amountWei = ethers.parseUnits(amt.toString(), CONFIG.OEOE_DECIMALS);

                // Anti-hedging: same player can only bet one food per round
                const existing = getRoundBets(gameState.roundId).filter(b => b.player === addr);
                if (existing.length > 0 && existing[0].foodIndex !== fi) {
                    return res.status(400).json({ error: 'Cannot hedge — already bet on another food this round' });
                }

                const betRecord = recordBet(gameState.roundId, player, fi, amountWei);
                try {
                    await dbPlaceBetAtomic({ roundId: gameState.roundId, player, foodIndex: fi, amountWei });
                } catch (e) {
                    // Rollback memory
                    const bets = gameData.bets.get(gameState.roundId);
                    if (bets) { const idx = bets.indexOf(betRecord); if (idx >= 0) bets.splice(idx, 1); }
                    return res.status(400).json({ error: e.message });
                }

                this.broadcast('bets-updated', { roundId: gameState.roundId, foodBets: this.getFoodBets(gameState.roundId) });
                logInfo(`Bet: ${formatAddr(player)} food#${fi} amount ${amt}`);
                res.json({ success: true, roundId: gameState.roundId });
            } catch (err) {
                logError('Bet error', err);
                res.status(500).json({ error: err.message });
            }
        });

        // Player balance
        this.app.get('/api/player-balance/:address', async (req, res) => {
            try {
                const bal = await dbGetPlayerBalance(req.params.address);
                const oeoe = ethers.formatUnits(bal.toString(), CONFIG.OEOE_DECIMALS);
                res.json({ address: req.params.address.toLowerCase(), balance: bal.toString(), balanceOEOE: oeoe });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Login
        this.app.post('/api/login', async (req, res) => {
            try {
                const { player, signature, timestamp } = req.body;
                if (!player) return res.status(400).json({ error: 'Missing player' });

                if (signature && timestamp) {
                    const ts = Number(timestamp);
                    if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return res.status(400).json({ error: 'Signature expired' });
                    const message = `FrogGame Login: ${player.toLowerCase()}:${timestamp}`;
                    const recovered = ethers.verifyMessage(message, signature);
                    if (recovered.toLowerCase() !== player.toLowerCase()) return res.status(403).json({ error: 'Invalid signature' });
                }

                const token = await dbCreateSession(player, req.ip || '', req.get('User-Agent') || '');

                // Sync balance from chain on login
                try {
                    const chainBal = await this.contract.playerBalances(player);
                    await dbSetPlayerBalance(player, chainBal.toString());
                } catch (e) { logError('Login sync failed', e); }

                const bal = await dbGetPlayerBalance(player);
                const balOEOE = Number(ethers.formatUnits(bal.toString(), CONFIG.OEOE_DECIMALS));
                logInfo(`Login: ${formatAddr(player)} balance=${balOEOE}`);
                res.json({ success: true, token, balance: balOEOE, balanceWei: bal.toString() });
            } catch (err) {
                logError('Login error', err);
                res.status(500).json({ error: err.message });
            }
        });

        // Deposit
        this.app.post('/api/deposit', async (req, res) => {
            try {
                const { player, amount, txHash } = req.body;
                if (!player || !amount) return res.status(400).json({ error: 'Missing params' });
                const addr = player.toLowerCase();
                const amountWei = ethers.parseUnits(Number(amount).toString(), CONFIG.OEOE_DECIMALS);

                if (txHash) {
                    const dup = await new Promise((r, rj) => db.get(`SELECT id FROM deposits WHERE address = ? AND tx_hash = ?`, [addr, txHash], (e, row) => e ? rj(e) : r(row)));
                    if (dup) return res.json({ success: true, duplicate: true });
                }

                await dbAddPlayerBalance(addr, amountWei);
                db.run(`INSERT INTO deposits (address, amount, tx_hash, status, created_at) VALUES (?, ?, ?, 'completed', ?)`, [addr, amountWei.toString(), txHash || null, Date.now()]);

                const newBal = await dbGetPlayerBalance(addr);
                const newBalOEOE = Number(ethers.formatUnits(newBal.toString(), CONFIG.OEOE_DECIMALS));
                res.json({ success: true, balance: newBalOEOE });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Withdraw
        this.app.post('/api/withdraw', async (req, res) => {
            try {
                const { player, amount, txHash, token } = req.body;
                if (!player || !amount) return res.status(400).json({ error: 'Missing params' });
                if (token) { const valid = await dbValidateSession(player, token); if (!valid) return res.status(403).json({ error: 'Invalid session' }); }

                const addr = player.toLowerCase();
                const amountWei = ethers.parseUnits(Number(amount).toString(), CONFIG.OEOE_DECIMALS);

                // Deduct server balance
                const current = await dbGetPlayerBalance(addr);
                if (current < amountWei) return res.status(400).json({ error: 'Insufficient balance' });

                await new Promise((resolve, reject) => {
                    db.run(`UPDATE player_balances SET balance = player_balances.balance - $1, updated_at = $2 WHERE address = $3 AND player_balances.balance >= $4`,
                        [amountWei.toString(), Date.now(), addr, amountWei.toString()], function(err) { if (err || this.changes === 0) reject(err || new Error('Insufficient')); else resolve(); });
                });

                db.run(`INSERT INTO withdrawals (address, amount, tx_hash, status, created_at) VALUES (?, ?, ?, 'completed', ?)`, [addr, amountWei.toString(), txHash || null, Date.now()]);
                res.json({ success: true });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Sync balance from chain
        this.app.post('/api/sync-balance', async (req, res) => {
            try {
                const { player } = req.body;
                if (!player) return res.status(400).json({ error: 'Missing player' });
                const chainBal = await this.contract.playerBalances(player);
                await dbSetPlayerBalance(player, chainBal.toString());
                const oeoe = Number(ethers.formatUnits(chainBal, CONFIG.OEOE_DECIMALS));
                res.json({ success: true, balance: oeoe });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // History
        this.app.get('/api/history/:address', async (req, res) => {
            try {
                const history = await dbGetPlayerHistory(req.params.address);
                res.json({ history });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Leaderboard
        this.app.get('/api/leaderboard', async (req, res) => {
            try {
                const rows = await new Promise((r, rj) => db.all(`SELECT address, total_invested, total_profit, total_bets, ROW_NUMBER() OVER (ORDER BY total_invested DESC) - 1 as rank FROM leaderboard ORDER BY total_invested DESC LIMIT 100`, [], (e, rows) => e ? rj(e) : r(rows || [])));
                res.json({ leaderboard: rows });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });

        // Settlement result
        this.app.get('/api/settlement', (req, res) => {
            const rid = parseInt(req.query.roundId) || gameState.roundId;
            if (gameState.lastSettlement && gameState.lastSettlement.roundId === rid) {
                return res.json(gameState.lastSettlement);
            }
            res.json({ roundId: rid, winningFood: null, rewardPool: 0, winnerTotal: 0, totalPool: 0 });
        });

        // Config
        this.app.get('/api/config', (req, res) => {
            res.json({
                contracts: { token: CONFIG.TOKEN_ADDRESS, game: CONFIG.GAME_CONTRACT },
                chain: { chainId: CONFIG.CHAIN_ID, chainName: 'X Layer', rpcUrl: CONFIG.RPC_URL },
                game: { roundDuration: CONFIG.ROUND_DURATION, economics: { rewardPercent: 90, burnPercent: 2, devPercent: 8 } },
                serverAddress: this.serverAddress
            });
        });

        // Health
        this.app.get('/api/health', (req, res) => {
            res.json({ status: 'ok', currentRound: gameState.roundId, state: gameState.state, phase: gameState.phase, wsClients: wsClients.size });
        });
    }

    // ==================== Game Loop ====================
    startNewRound() {
        if (gameState.isStartingNewRound || gameState.isSettling) return;
        gameState.isStartingNewRound = true;

        const now = Math.floor(Date.now() / 1000);
        if (gameState.settleTimerId) { clearTimeout(gameState.settleTimerId); gameState.settleTimerId = null; }

        gameState.roundId++;
        gameState.startTime = now;
        gameState.endTime = now + CONFIG.ROUND_DURATION;
        gameState.state = 'BETTING';
        gameState.phase = 'BETTING';
        gameState.winningFood = null;
        gameState.lastSettlement = null;

        // Cleanup old round memory (keep 3 rounds)
        const old = gameState.roundId - 3;
        if (old > 0) gameData.bets.delete(old);

        logInfo(`New round: #${gameState.roundId} | duration=${CONFIG.ROUND_DURATION}s`);
        this.broadcast('round-started', { roundId: gameState.roundId, startTime: gameState.startTime, endTime: gameState.endTime, phase: 'BETTING' });

        setTimeout(() => { gameState.isStartingNewRound = false; }, 1000);

        gameState.settleTimerId = setTimeout(async () => {
            try { await this.settleRound(); } catch (err) {
                logError('Settlement error', err);
                gameState.isSettling = false;
                gameState.state = 'BETTING';
            }
            setTimeout(() => { if (!gameState.isStartingNewRound) this.startNewRound(); }, 1000);
        }, CONFIG.ROUND_DURATION * 1000);
    }

    async settleRound() {
        if (gameState.isSettling) return;
        if (gameState.state !== 'BETTING') return;

        gameState.isSettling = true;
        gameState.state = 'SETTLING';
        gameState.phase = 'SETTLING';

        try {
            const bets = getRoundBets(gameState.roundId);

            // Random food selection
            const randomBytes = crypto.randomBytes(32);
            const winningFood = Number(BigInt('0x' + randomBytes.toString('hex')) % 8n);
            gameState.winningFood = winningFood;

            if (bets.length === 0) {
                // Empty round
                gameState.lastSettlement = { roundId: gameState.roundId, winningFood, rewardPool: 0, winnerTotal: 0, totalPool: 0, isNoContest: true, loserReductions: [] };
                this.broadcast('round-settled', { roundId: gameState.roundId, winningFood, isNoContest: true, totalPool: 0, phase: 'SETTLING' });
                db.run(`INSERT INTO round_settlements (round_id, winning_food, total_pool, winner_count, is_no_contest, settled_at) VALUES (?, ?, 0, 0, true, ?)`, [gameState.roundId, winningFood, Date.now()]);
                return;
            }

            // Merge bets per player
            const mergedMap = new Map();
            for (const bet of bets) {
                const key = `${bet.player}:${bet.foodIndex}`;
                if (mergedMap.has(key)) { mergedMap.get(key).amount += BigInt(bet.amount); }
                else { mergedMap.set(key, { player: bet.player, foodIndex: bet.foodIndex, amount: BigInt(bet.amount) }); }
            }
            const merged = Array.from(mergedMap.values());

            const betFoods = new Set(merged.map(b => b.foodIndex));
            const isNoContest = betFoods.size <= 1;

            if (isNoContest) {
                // Return all bets
                for (const bet of merged) await dbAddPlayerBalance(bet.player, bet.amount);
                gameState.lastSettlement = { roundId: gameState.roundId, winningFood, rewardPool: 0, winnerTotal: 0, totalPool: 0, isNoContest: true, loserReductions: [] };
                this.broadcast('round-settled', { roundId: gameState.roundId, winningFood, isNoContest: true, totalPool: 0, allPlayers: merged.map(b => b.player), allReturns: merged.map(b => Number(b.amount) / 1e9) });
                return;
            }

            // Calculate loser pool with damage reduction
            const loserReductions = [];
            let losingPool = 0n;
            for (const bet of merged) {
                if (bet.foodIndex === winningFood) {
                    const rank = await dbGetPlayerLastDayRank(bet.player);
                    const rate = getDamageReductionRate(rank);
                    const saved = bet.amount * BigInt(Math.round(rate * 10000)) / 10000n;
                    const final = bet.amount - saved;
                    losingPool += final;
                    loserReductions.push({ player: bet.player, originalAmount: bet.amount, savedAmount: saved, finalAmount: final, rank, reductionRate: rate });
                }
            }

            const rewardPool = losingPool * 90n / 100n;
            const burnAmount = losingPool * 2n / 100n;
            const devAmount = losingPool * 8n / 100n;

            // Calculate winners
            let winnerTotal = 0n;
            const winners = [];
            const rewards = [];
            for (const bet of merged) {
                if (bet.foodIndex !== winningFood) winnerTotal += bet.amount;
            }
            for (const bet of merged) {
                if (bet.foodIndex !== winningFood && winnerTotal > 0n) {
                    const share = (bet.amount * rewardPool) / winnerTotal;
                    winners.push(bet.player);
                    rewards.push(share);
                }
            }

            if (winners.length === 0) {
                // No winners — return all
                for (const l of loserReductions) await dbAddPlayerBalance(l.player, l.originalAmount);
                gameState.lastSettlement = { roundId: gameState.roundId, winningFood, rewardPool: 0, winnerTotal: 0, totalPool: Number(losingPool) / 1e9, isNoContest: false, noWinner: true, loserReductions: loserReductions.map(l => ({ player: l.player, originalAmount: Number(l.originalAmount) / 1e9, savedAmount: 0, finalAmount: 0, reductionRate: 0 })) };
                this.broadcast('round-settled', { roundId: gameState.roundId, winningFood, isNoContest: false, noWinner: true, totalPool: Number(losingPool) / 1e9 });
                return;
            }

            // Return saved amounts to losers
            for (const l of loserReductions) {
                if (l.savedAmount > 0n) await dbAddPlayerBalance(l.player, l.savedAmount);
            }

            // Credit winners: principal + reward
            for (let i = 0; i < winners.length; i++) {
                const bet = merged.find(b => b.player === winners[i] && b.foodIndex !== winningFood);
                const principal = bet ? bet.amount : 0n;
                await dbAddPlayerBalance(winners[i], principal + rewards[i]);
            }

            const totalPool = merged.filter(b => b.foodIndex === winningFood).reduce((s, b) => s + b.amount, 0n);

            // Set settlement data
            gameState.lastSettlement = {
                roundId: gameState.roundId,
                winningFood,
                rewardPool: Number(rewardPool) / 1e9,
                winnerTotal: Number(winnerTotal) / 1e9,
                totalPool: Number(totalPool) / 1e9,
                losingPool: Number(losingPool) / 1e9,
                isNoContest: false,
                loserReductions: loserReductions.map(l => ({ player: l.player, originalAmount: Number(l.originalAmount) / 1e9, savedAmount: Number(l.savedAmount) / 1e9, finalAmount: Number(l.finalAmount) / 1e9, reductionRate: l.reductionRate }))
            };

            // Build player results
            const playerResults = {};
            for (let i = 0; i < winners.length; i++) {
                playerResults[winners[i]] = { result: 'win', changeAmount: Number(rewards[i]) / 1e9 };
            }
            for (const l of loserReductions) {
                playerResults[l.player] = { result: 'lose', changeAmount: -(Number(l.finalAmount) / 1e9), savedAmount: Number(l.savedAmount) / 1e9 };
            }

            this.broadcast('round-settled', {
                roundId: gameState.roundId, winningFood, isNoContest: false,
                totalPool: Number(totalPool) / 1e9, rewardPool: Number(rewardPool) / 1e9,
                burnAmount: Number(burnAmount) / 1e9, devAmount: Number(devAmount) / 1e9,
                winnerCount: winners.length, winnerTotal: Number(winnerTotal) / 1e9,
                loserReductions: gameState.lastSettlement.loserReductions, playerResults
            });

            // On-chain settlement
            if (losingPool > 0n) {
                try {
                    let chainRoundId = gameState.cachedChainRoundId;
                    if (chainRoundId === null) chainRoundId = Number(await this.contract.currentRoundId());
                    const actualRoundId = chainRoundId + 1;

                    const losers = loserReductions.map(l => l.player);
                    const loserAmountsWei = loserReductions.map(l => l.finalAmount.toString());
                    const rewardsWei = rewards.map(r => r.toString());

                    const roundData = ethers.solidityPacked(['uint256', 'uint8', 'address[]', 'uint256[]', 'address[]', 'uint256[]'], [actualRoundId, winningFood, losers, loserAmountsWei, winners, rewardsWei]);
                    const roundHash = ethers.keccak256(roundData);
                    const sig = await this.wallet.signMessage(ethers.getBytes(roundHash));

                    const tx = await this.contract.settleRound(actualRoundId, roundHash, sig, losers, loserAmountsWei, winners, rewardsWei, { gasLimit: 2000000 });
                    await tx.wait();
                    gameState.cachedChainRoundId = actualRoundId;
                    logInfo(`On-chain settlement success: tx=${tx.hash}`);
                } catch (err) {
                    logError('On-chain settlement failed', err);
                }
            }

            // Record settlement
            db.run(`INSERT INTO round_settlements (round_id, winning_food, total_pool, winner_count, burn_amount, dev_amount, is_no_contest, settled_at) VALUES (?, ?, ?, ?, ?, ?, false, ?)`,
                [gameState.roundId, winningFood, Number(totalPool), winners.length, Number(burnAmount), Number(devAmount), Date.now()]);

            // Update leaderboard
            for (let i = 0; i < winners.length; i++) {
                const bet = merged.find(b => b.player === winners[i]);
                await dbUpdateLeaderboard(winners[i], Number(bet?.amount || 0n) / 1e9, Number(rewards[i]) / 1e9);
            }
            for (const l of loserReductions) {
                await dbUpdateLeaderboard(l.player, Number(l.originalAmount) / 1e9, -(Number(l.finalAmount) / 1e9));
            }

            logInfo(`Round #${gameState.roundId} settled ———— winners=${winners.length} losers=${loserReductions.length}`);
        } finally {
            gameState.isSettling = false;
            gameState.state = 'BETTING';
            gameState.phase = 'BETTING';
        }
    }

    async init() {
        await dbAdapter.init();
        logInfo('Database connected');

        try {
            const chainRoundId = await this.contract.currentRoundId();
            gameState.cachedChainRoundId = Number(chainRoundId);
            logInfo(`Chain currentRoundId=${gameState.cachedChainRoundId}`);
        } catch (e) {
            gameState.cachedChainRoundId = null;
            logError('Failed to query chain roundId', e);
        }

        // Recovery timer
        setInterval(() => {
            if (gameState.isSettling || gameState.isStartingNewRound) return;
            const now = Math.floor(Date.now() / 1000);
            if (now - gameState.endTime > 10 && gameState.state === 'BETTING') {
                logInfo('Recovery: forcing new round');
                this.startNewRound();
            }
        }, 10000);

        this.startNewRound();

        await new Promise(resolve => {
            this.server.listen(CONFIG.PORT, CONFIG.HOST, () => {
                logInfo(`Server listening on http://${CONFIG.HOST}:${CONFIG.PORT}`);
                logInfo(`AI Agent API: /api/ai/strategy | /api/ai/history-analysis | /api/ai/risk-assessment/:addr | /api/ai/chat`);
                logInfo(`OnchainOS API: /api/onchainos/wallet-balance | /api/onchainos/token-price | /api/onchainos/market-overview`);
                resolve();
            });
        });
    }
}

// ============ Start ============
const server = new FrogGameAIServer();
server.init().catch(err => { console.error('Startup failed:', err); process.exit(1); });

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
