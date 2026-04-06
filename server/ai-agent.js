/**
 * AI Strategy Analysis Engine for FrogGame
 * 
 * Provides:
 * - Real-time betting distribution analysis
 * - Historical food selection pattern analysis
 * - Player risk assessment and bet sizing recommendations
 * - Natural language game advisor (chat)
 */

class AIAgent {
    /**
     * @param {Object} deps
     * @param {Function} deps.getRoundBets - Get current round bets
     * @param {Function} deps.getGameState - Get current game state
     * @param {Object} deps.db - Database shim { all, get }
     * @param {Object} deps.onchainos - OnchainOS instance
     * @param {Object} deps.config - Server config
     */
    constructor(deps) {
        this.getRoundBets = deps.getRoundBets;
        this.getGameState = deps.getGameState;
        this.db = deps.db;
        this.onchainos = deps.onchainos;
        this.config = deps.config;

        this.FOODS = [
            { index: 0, name: 'Apple', emoji: '🍎' },
            { index: 1, name: 'Banana', emoji: '🍌' },
            { index: 2, name: 'Cherry', emoji: '🍒' },
            { index: 3, name: 'Grape', emoji: '🍇' },
            { index: 4, name: 'Watermelon', emoji: '🍉' },
            { index: 5, name: 'Peach', emoji: '🍑' },
            { index: 6, name: 'Strawberry', emoji: '🍓' },
            { index: 7, name: 'Orange', emoji: '🍊' }
        ];
    }

    // ==================== Strategy Analysis ====================

    /**
     * Analyze current round betting distribution and recommend strategy
     * GET /api/ai/strategy
     */
    async analyzeStrategy(roundId) {
        const bets = this.getRoundBets(roundId);
        const gameState = this.getGameState();

        // Calculate per-food stats
        const foodStats = this.FOODS.map(food => {
            const foodBets = bets.filter(b => Number(b.foodIndex) === food.index);
            const totalBetWei = foodBets.reduce((sum, b) => {
                return sum + (typeof b.amount === 'bigint' ? Number(b.amount) : Number(b.amount || 0));
            }, 0);
            const totalBetOEOE = totalBetWei / 1e9;
            const uniqueBettors = new Set(foodBets.map(b => b.player)).size;

            return {
                ...food,
                totalBet: totalBetOEOE,
                totalBetWei,
                bettorCount: uniqueBettors,
                betCount: foodBets.length
            };
        });

        const totalPool = foodStats.reduce((sum, f) => sum + f.totalBet, 0);
        const bettedFoods = foodStats.filter(f => f.totalBet > 0);
        const unbettedFoods = foodStats.filter(f => f.totalBet === 0);

        // Each food has equal 1/8 chance of being eaten
        // If your food is NOT eaten (7/8 chance), you win
        // Reward comes from the eaten food's pool (losing pool)
        // Strategy: bet on food with LEAST bets = highest potential reward ratio
        const sortedByBet = [...foodStats].sort((a, b) => a.totalBet - b.totalBet);
        const leastBetted = sortedByBet.filter(f => f.totalBet > 0);
        const mostBetted = [...sortedByBet].reverse();

        // Calculate expected value for each food
        const foodEV = foodStats.map(food => {
            if (totalPool === 0) {
                return { ...food, ev: 0, survivalRate: 7 / 8, potentialReward: 0 };
            }

            // Probability this food is eaten = 1/8
            // If you bet on food X:
            //   - 1/8 chance: food X is eaten → you lose your bet
            //   - 7/8 chance: another food is eaten → you get share of loser pool * 90%
            const survivalRate = 7 / 8;
            const otherFoodsPool = totalPool - food.totalBet;
            // Expected loser pool = average of each other food's pool (each with 1/7 chance of being the eaten one)
            // Simplified: any of the 7 other foods could be eaten, each equally likely
            // Average losing pool per scenario = otherFoodsPool / 7 (not exactly, but approximation)
            // Actually: if food X survives, one of the OTHER 7 foods is eaten.
            // Each other food has 1/7 chance (conditional). So expected loser pool = sum of each food's bet * (1/7)
            // which equals otherFoodsPool / 7... no. Expected loser pool = E[bet of eaten food] = (sum of other food bets) / 7
            // But this is wrong too. Let me reconsider.
            
            // Actually: When food X survives (prob 7/8), the eaten food is uniform among the other 7.
            // The losing pool = bet amount on the eaten food.
            // E[losing pool | X survives] = (sum of bets on each other food) / 7
            // Wait, that's also wrong. Each of the other 7 foods has equal 1/7 chance of being eaten.
            // E[losing pool | X survives] = (1/7) * sum_of_each_other_food_bet = otherFoodsPool / 7
            
            // Your reward share = (your_bet / food_X_total_bet) * loser_pool * 0.9
            // But if food_X_total_bet = 0, no reward.
            
            const avgLoserPool = otherFoodsPool / 7;
            const rewardPool = avgLoserPool * 0.9;
            const myShareRatio = food.totalBet > 0 ? 1 / food.bettorCount : 1; // simplified
            
            // EV = 7/8 * (reward_share - 0) + 1/8 * (-bet)
            // For 1 OEOE bet:
            const betUnit = 1;
            const shareOfReward = food.totalBet > 0
                ? (betUnit / (food.totalBet + betUnit)) * rewardPool
                : rewardPool; // if you'd be the only bettor
            const ev = survivalRate * shareOfReward - (1 / 8) * betUnit;

            return {
                ...food,
                ev: Math.round(ev * 10000) / 10000,
                survivalRate,
                potentialReward: Math.round(shareOfReward * 100) / 100,
                avgLoserPool: Math.round(avgLoserPool * 100) / 100
            };
        });

        // Recommendations
        const recommendations = [];

        if (unbettedFoods.length > 0) {
            recommendations.push({
                type: 'opportunity',
                message: `${unbettedFoods.length} food(s) have no bets yet — betting on them means maximum reward share if they survive.`,
                foods: unbettedFoods.map(f => f.emoji + ' ' + f.name)
            });
        }

        if (bettedFoods.length === 1) {
            recommendations.push({
                type: 'warning',
                message: 'Only 1 food has bets — if no other food gets bets, this will be a no-contest round (all bets returned).'
            });
        }

        const bestEV = foodEV.reduce((best, f) => f.ev > best.ev ? f : best, foodEV[0]);
        if (bestEV.ev > 0) {
            recommendations.push({
                type: 'strategy',
                message: `Best expected value: ${bestEV.emoji} ${bestEV.name} (EV: +${bestEV.ev} per OEOE bet)`,
                food: bestEV
            });
        }

        if (mostBetted[0] && mostBetted[0].totalBet > 0) {
            recommendations.push({
                type: 'risk',
                message: `Highest risk food: ${mostBetted[0].emoji} ${mostBetted[0].name} with ${mostBetted[0].totalBet.toLocaleString()} OEOE — most competition for rewards.`
            });
        }

        return {
            roundId,
            timeLeft: gameState.timeLeft || 0,
            phase: gameState.phase || gameState.state,
            totalPool,
            foodStats,
            foodEV: foodEV.sort((a, b) => b.ev - a.ev),
            recommendations,
            unbettedFoods: unbettedFoods.map(f => ({ index: f.index, name: f.name, emoji: f.emoji })),
            timestamp: Date.now()
        };
    }

    // ==================== History Analysis ====================

    /**
     * Analyze historical data: food selection frequency, win rates
     * GET /api/ai/history-analysis
     */
    async analyzeHistory() {
        // Get all round settlements
        const settlements = await new Promise((resolve, reject) => {
            this.db.all(`
                SELECT round_id, winning_food, total_pool, winner_count, is_no_contest, settled_at
                FROM round_settlements
                ORDER BY settled_at DESC
                LIMIT 500
            `, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const totalRounds = settlements.length;
        const contestedRounds = settlements.filter(s => !s.is_no_contest).length;

        // Food eaten frequency
        const foodEatenCount = new Array(8).fill(0);
        const foodContestCount = new Array(8).fill(0); // times this food had bets in contested rounds
        
        for (const s of settlements) {
            if (s.winning_food !== null && s.winning_food !== undefined && !s.is_no_contest) {
                foodEatenCount[s.winning_food]++;
            }
        }

        // Get betting patterns from history
        const historyStats = await new Promise((resolve, reject) => {
            this.db.all(`
                SELECT 
                    eaten_food as "eatenFood",
                    COUNT(*) as total,
                    SUM(CASE WHEN is_win = true THEN 1 ELSE 0 END) as wins,
                    SUM(CASE WHEN is_win = false THEN 1 ELSE 0 END) as losses,
                    AVG(CASE WHEN is_win = true THEN profit ELSE 0 END) as avg_win_profit,
                    AVG(CASE WHEN is_win = false THEN profit ELSE 0 END) as avg_loss
                FROM history
                GROUP BY eaten_food
            `, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // Aggregate per food
        const foodAnalysis = this.FOODS.map(food => {
            const eatenCount = foodEatenCount[food.index];
            const eatenRate = contestedRounds > 0 ? (eatenCount / contestedRounds * 100) : 0;
            const expected = contestedRounds > 0 ? (contestedRounds / 8) : 0;
            const deviation = expected > 0 ? ((eatenCount - expected) / expected * 100) : 0;

            const hist = historyStats.find(h => h.eatenFood === food.index);

            return {
                ...food,
                eatenCount,
                eatenRate: Math.round(eatenRate * 100) / 100,
                expectedRate: 12.5, // 1/8
                deviation: Math.round(deviation * 100) / 100,
                totalBetsOnRecord: hist ? hist.total : 0,
                avgWinProfit: hist ? Math.round((hist.avg_win_profit || 0) * 100) / 100 : 0,
                avgLoss: hist ? Math.round((hist.avg_loss || 0) * 100) / 100 : 0
            };
        });

        // Streaks: consecutive times a food was/wasn't eaten
        const recentEaten = settlements
            .filter(s => !s.is_no_contest && s.winning_food !== null)
            .slice(0, 20)
            .map(s => s.winning_food);

        // Check if any food hasn't been eaten in a while (gambler's fallacy note)
        const roundsSinceEaten = this.FOODS.map(food => {
            const idx = recentEaten.indexOf(food.index);
            return {
                ...food,
                roundsSinceEaten: idx >= 0 ? idx : recentEaten.length,
                note: idx < 0 ? 'Not eaten in recent history' : null
            };
        });

        return {
            totalRounds,
            contestedRounds,
            noContestRounds: totalRounds - contestedRounds,
            foodAnalysis: foodAnalysis.sort((a, b) => b.eatenCount - a.eatenCount),
            recentEatenSequence: recentEaten.slice(0, 10).map(i => this.FOODS[i]?.emoji || '?'),
            roundsSinceEaten: roundsSinceEaten.sort((a, b) => b.roundsSinceEaten - a.roundsSinceEaten),
            disclaimer: 'Each food has an equal 1/8 (12.5%) chance of being eaten. Past results do not influence future outcomes. This analysis is for reference only.',
            timestamp: Date.now()
        };
    }

    // ==================== Risk Assessment ====================

    /**
     * Assess player risk profile and suggest bet sizing
     * GET /api/ai/risk-assessment/:address
     */
    async assessRisk(address) {
        const addr = address.toLowerCase();

        // Get player balance
        const balanceRow = await new Promise((resolve, reject) => {
            this.db.get(`SELECT balance FROM player_balances WHERE address = $1`, [addr], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        const balanceWei = balanceRow ? BigInt(balanceRow.balance || '0') : 0n;
        const balanceOEOE = Number(balanceWei) / 1e9;

        // Get player history
        const history = await new Promise((resolve, reject) => {
            this.db.all(`
                SELECT is_win, profit, bet_amount
                FROM history
                WHERE address = $1
                ORDER BY created_at DESC
                LIMIT 100
            `, [addr], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const totalGames = history.length;
        const wins = history.filter(h => h.is_win).length;
        const losses = totalGames - wins;
        const winRate = totalGames > 0 ? (wins / totalGames * 100) : 0;

        // Calculate profit/loss stats
        const profits = history.map(h => Number(h.profit || 0));
        const totalProfit = profits.reduce((s, p) => s + p, 0);
        const avgProfit = totalGames > 0 ? totalProfit / totalGames : 0;
        const maxWin = Math.max(0, ...profits);
        const maxLoss = Math.min(0, ...profits);

        // Recent streak
        let currentStreak = 0;
        let streakType = null;
        for (const h of history) {
            const isWin = h.is_win;
            if (streakType === null) {
                streakType = isWin ? 'win' : 'loss';
                currentStreak = 1;
            } else if ((isWin && streakType === 'win') || (!isWin && streakType === 'loss')) {
                currentStreak++;
            } else {
                break;
            }
        }

        // Bet amounts analysis
        const betAmounts = history.map(h => Number(h.bet_amount || 0) / 1e9).filter(a => a > 0);
        const avgBet = betAmounts.length > 0 ? betAmounts.reduce((s, a) => s + a, 0) / betAmounts.length : 0;
        const maxBet = Math.max(0, ...betAmounts);

        // Risk profile classification
        let riskProfile = 'moderate';
        let riskScore = 50;

        if (balanceOEOE <= 0) {
            riskProfile = 'depleted';
            riskScore = 100;
        } else if (avgBet > balanceOEOE * 0.3) {
            riskProfile = 'aggressive';
            riskScore = 80;
        } else if (avgBet > balanceOEOE * 0.1) {
            riskProfile = 'moderate';
            riskScore = 50;
        } else {
            riskProfile = 'conservative';
            riskScore = 20;
        }

        // Adjust for streak
        if (streakType === 'loss' && currentStreak >= 3) {
            riskScore = Math.min(100, riskScore + 15);
        }

        // Bet sizing recommendations (Kelly-inspired, simplified)
        // With 7/8 win rate and variable payoff, optimal bet fraction is small
        const suggestedBetPercent = riskProfile === 'aggressive' ? 5 : riskProfile === 'conservative' ? 2 : 3;
        const suggestedBet = Math.max(1000, Math.floor(balanceOEOE * suggestedBetPercent / 100));

        const recommendations = [];

        if (riskProfile === 'depleted') {
            recommendations.push('Your balance is empty. Consider depositing more OEOE before playing.');
        } else if (riskProfile === 'aggressive') {
            recommendations.push(`Your average bet (${avgBet.toLocaleString()} OEOE) is high relative to balance. Consider reducing to ${suggestedBet.toLocaleString()} OEOE per round.`);
        }

        if (streakType === 'loss' && currentStreak >= 3) {
            recommendations.push(`You are on a ${currentStreak}-round losing streak. Avoid chasing losses — the game is random.`);
        }

        if (streakType === 'win' && currentStreak >= 3) {
            recommendations.push(`Nice ${currentStreak}-round winning streak! Remember each round is independent.`);
        }

        if (winRate > 0 && winRate < 50 && totalGames >= 10) {
            recommendations.push('Your win rate is below average. This is likely variance — with enough games it should converge to ~87.5% survival rate.');
        }

        recommendations.push(`Suggested bet size: ${suggestedBet.toLocaleString()} OEOE (${suggestedBetPercent}% of balance)`);

        return {
            address: addr,
            balance: balanceOEOE,
            stats: {
                totalGames,
                wins,
                losses,
                winRate: Math.round(winRate * 100) / 100,
                totalProfit: Math.round(totalProfit * 100) / 100,
                avgProfit: Math.round(avgProfit * 100) / 100,
                maxWin: Math.round(maxWin * 100) / 100,
                maxLoss: Math.round(maxLoss * 100) / 100,
                avgBet: Math.round(avgBet),
                maxBet: Math.round(maxBet)
            },
            streak: {
                type: streakType,
                count: currentStreak
            },
            riskProfile,
            riskScore,
            suggestedBet,
            suggestedBetPercent,
            recommendations,
            timestamp: Date.now()
        };
    }

    // ==================== Natural Language Chat ====================

    /**
     * Process natural language input and return game advice
     * POST /api/ai/chat
     */
    async chat(message, address) {
        const msg = (message || '').toLowerCase().trim();
        if (!msg) {
            return { reply: 'Please send a message. Try "analyze" or "what should I bet?"', actions: [] };
        }

        const actions = [];
        let reply = '';

        // Intent detection (keyword-based, no LLM dependency)
        if (msg.includes('analyz') || msg.includes('分析') || msg.includes('局势') || msg.includes('situation')) {
            const strategy = await this.analyzeStrategy(this.getGameState().roundId);
            const topEV = strategy.foodEV[0];
            reply = `📊 **Round #${strategy.roundId} Analysis**\n`;
            reply += `Total pool: ${strategy.totalPool.toLocaleString()} OEOE\n`;
            reply += `Active foods: ${strategy.foodStats.filter(f => f.totalBet > 0).length}/8\n`;
            if (strategy.unbettedFoods.length > 0) {
                reply += `\n🎯 Unbetted foods (max reward potential): ${strategy.unbettedFoods.map(f => f.emoji).join(' ')}\n`;
            }
            if (topEV) {
                reply += `\n💡 Best EV: ${topEV.emoji} ${topEV.name} (EV: ${topEV.ev > 0 ? '+' : ''}${topEV.ev})`;
            }
            for (const rec of strategy.recommendations) {
                reply += `\n${rec.type === 'warning' ? '⚠️' : rec.type === 'opportunity' ? '🎯' : '💡'} ${rec.message}`;
            }
            actions.push({ type: 'show_strategy', data: strategy });

        } else if (msg.includes('how much') || msg.includes('多少') || msg.includes('投多少') || msg.includes('bet size') || msg.includes('sizing')) {
            if (!address) {
                reply = '🔗 Please connect your wallet first so I can assess your risk profile.';
            } else {
                const risk = await this.assessRisk(address);
                reply = `💰 **Bet Recommendation for ${address.slice(0, 6)}...${address.slice(-4)}**\n`;
                reply += `Balance: ${risk.balance.toLocaleString()} OEOE\n`;
                reply += `Risk profile: ${risk.riskProfile} (score: ${risk.riskScore}/100)\n`;
                reply += `Suggested bet: ${risk.suggestedBet.toLocaleString()} OEOE\n`;
                if (risk.streak.type && risk.streak.count > 1) {
                    reply += `Current streak: ${risk.streak.count}x ${risk.streak.type}\n`;
                }
                for (const rec of risk.recommendations) {
                    reply += `\n• ${rec}`;
                }
                actions.push({ type: 'suggest_bet', amount: risk.suggestedBet });
            }

        } else if (msg.includes('history') || msg.includes('历史') || msg.includes('统计') || msg.includes('stats')) {
            const hist = await this.analyzeHistory();
            reply = `📈 **Historical Analysis** (${hist.totalRounds} rounds)\n`;
            reply += `Contested: ${hist.contestedRounds} | No-contest: ${hist.noContestRounds}\n\n`;
            reply += `Recent eaten: ${hist.recentEatenSequence.join(' ')}\n\n`;
            reply += `Food eaten frequency:\n`;
            for (const food of hist.foodAnalysis.slice(0, 4)) {
                reply += `${food.emoji} ${food.name}: ${food.eatenCount}x (${food.eatenRate}%, deviation: ${food.deviation > 0 ? '+' : ''}${food.deviation}%)\n`;
            }
            reply += `\n⚠️ ${hist.disclaimer}`;
            actions.push({ type: 'show_history', data: hist });

        } else if (msg.includes('price') || msg.includes('价格') || msg.includes('market') || msg.includes('市场')) {
            try {
                const tokenAddr = this.config.TOKEN_ADDRESS;
                const overview = await this.onchainos.getMarketOverview(tokenAddr);
                reply = `💹 **OEOE Market Data**\n`;
                if (overview.price) {
                    reply += `Price: $${overview.price.price || 'N/A'}\n`;
                }
                if (overview.tokenInfo) {
                    reply += `Market Cap: ${overview.tokenInfo.marketCap || 'N/A'}\n`;
                }
                reply += `\nData from OnchainOS DEX API`;
            } catch (err) {
                reply = `❌ Failed to fetch market data: ${err.message}`;
            }

        } else if (msg.includes('help') || msg.includes('帮助') || msg.includes('what can') || msg.includes('你能')) {
            reply = `🐸 **FrogGame AI Assistant**\n\n`;
            reply += `Available commands:\n`;
            reply += `• "analyze" — Current round betting analysis\n`;
            reply += `• "how much should I bet" — Personalized bet sizing\n`;
            reply += `• "history" — Historical food statistics\n`;
            reply += `• "price" — OEOE token market data\n`;
            reply += `• "help" — Show this help\n`;
            reply += `\nYou can also ask in Chinese! 也可以用中文问我。`;

        } else {
            // Default: try to provide a useful response
            const strategy = await this.analyzeStrategy(this.getGameState().roundId);
            reply = `🐸 I'm not sure what you mean, but here's the current situation:\n`;
            reply += `Round #${strategy.roundId} | Pool: ${strategy.totalPool.toLocaleString()} OEOE | Phase: ${strategy.phase}\n`;
            reply += `\nType "help" for available commands.`;
        }

        return {
            reply,
            actions,
            timestamp: Date.now()
        };
    }
}

module.exports = AIAgent;
