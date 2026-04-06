/**
 * OnchainOS API Integration Module
 * 
 * Integrates with OKX OnchainOS APIs:
 * - Wallet API: Query wallet balances
 * - DEX API: Get token prices and market data
 * - Data API: Fetch on-chain analytics
 * 
 * Docs: https://web3.okx.com/build/docs/waas/dex-get-token-price
 */

const fetch = require('node-fetch');

const ONCHAINOS_BASE = 'https://web3.okx.com/api/v5';
const X_LAYER_CHAIN_ID = '196';

class OnchainOS {
    /**
     * @param {Object} config
     * @param {string} config.apiKey - OnchainOS API Key
     * @param {string} config.walletAddress - Agentic wallet address
     */
    constructor(config = {}) {
        this.apiKey = config.apiKey || process.env.ONCHAINOS_API_KEY || '';
        this.walletAddress = config.walletAddress || process.env.ONCHAINOS_WALLET || '';
        this.cache = new Map();
        this.cacheTTL = 30000; // 30s cache
    }

    /**
     * Make authenticated API request to OnchainOS
     */
    async _request(endpoint, params = {}) {
        const cacheKey = `${endpoint}:${JSON.stringify(params)}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < this.cacheTTL) {
            return cached.data;
        }

        const url = new URL(`${ONCHAINOS_BASE}${endpoint}`);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null) url.searchParams.set(k, v);
        });

        try {
            const res = await fetch(url.toString(), {
                headers: {
                    'Ok-Access-Key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            if (!res.ok) {
                throw new Error(`OnchainOS API error: ${res.status} ${res.statusText}`);
            }

            const json = await res.json();
            if (json.code !== '0' && json.code !== 0) {
                throw new Error(`OnchainOS API error: ${json.msg || JSON.stringify(json)}`);
            }

            const data = json.data;
            this.cache.set(cacheKey, { data, ts: Date.now() });
            return data;
        } catch (err) {
            console.error(`[OnchainOS] ${endpoint} failed:`, err.message);
            throw err;
        }
    }

    // ==================== Wallet API ====================

    /**
     * Get wallet token balances on X Layer
     * @param {string} address - Wallet address (defaults to agentic wallet)
     * @returns {Promise<Object[]>} Token balances
     */
    async getWalletBalance(address) {
        const addr = address || this.walletAddress;
        if (!addr) throw new Error('No wallet address provided');

        try {
            const data = await this._request('/dex/balance/token-balances-by-address', {
                chainIndex: X_LAYER_CHAIN_ID,
                address: addr
            });
            return data || [];
        } catch (err) {
            console.error('[OnchainOS] getWalletBalance failed:', err.message);
            return [];
        }
    }

    // ==================== DEX API ====================

    /**
     * Get token price from OnchainOS DEX aggregator
     * @param {string} tokenAddress - Token contract address
     * @returns {Promise<Object>} Price data { price, priceChange24h, ... }
     */
    async getTokenPrice(tokenAddress) {
        if (!tokenAddress) throw new Error('Token address required');

        try {
            const data = await this._request('/dex/market/candles', {
                chainId: X_LAYER_CHAIN_ID,
                tokenAddress,
                bar: '1H',
                limit: '1'
            });
            
            if (data && data.length > 0) {
                const candle = data[0];
                return {
                    price: parseFloat(candle[4]) || 0, // close price
                    open: parseFloat(candle[1]) || 0,
                    high: parseFloat(candle[2]) || 0,
                    low: parseFloat(candle[3]) || 0,
                    volume: parseFloat(candle[5]) || 0,
                    timestamp: parseInt(candle[0]) || Date.now()
                };
            }
            return { price: 0, timestamp: Date.now() };
        } catch (err) {
            console.error('[OnchainOS] getTokenPrice failed:', err.message);
            return { price: 0, timestamp: Date.now(), error: err.message };
        }
    }

    /**
     * Get recent trades for a token
     * @param {string} tokenAddress
     * @returns {Promise<Object[]>}
     */
    async getRecentTrades(tokenAddress) {
        try {
            const data = await this._request('/dex/market/trades', {
                chainId: X_LAYER_CHAIN_ID,
                tokenAddress,
                limit: '20'
            });
            return data || [];
        } catch (err) {
            console.error('[OnchainOS] getRecentTrades failed:', err.message);
            return [];
        }
    }

    /**
     * Get token info and market data
     * @param {string} tokenAddress
     * @returns {Promise<Object>}
     */
    async getTokenInfo(tokenAddress) {
        try {
            const data = await this._request('/dex/token/token-list', {
                chainId: X_LAYER_CHAIN_ID,
                tokenAddress
            });
            return data && data.length > 0 ? data[0] : null;
        } catch (err) {
            console.error('[OnchainOS] getTokenInfo failed:', err.message);
            return null;
        }
    }

    // ==================== Data / Analytics API ====================

    /**
     * Get supported chains list
     */
    async getSupportedChains() {
        try {
            return await this._request('/dex/cross-chain/supported/chain');
        } catch (err) {
            return [];
        }
    }

    /**
     * Get comprehensive market overview for OEOE token
     * Aggregates price, balance, and trade data
     */
    async getMarketOverview(tokenAddress) {
        const [price, tokenInfo, trades] = await Promise.allSettled([
            this.getTokenPrice(tokenAddress),
            this.getTokenInfo(tokenAddress),
            this.getRecentTrades(tokenAddress)
        ]);

        return {
            price: price.status === 'fulfilled' ? price.value : null,
            tokenInfo: tokenInfo.status === 'fulfilled' ? tokenInfo.value : null,
            recentTrades: trades.status === 'fulfilled' ? trades.value : [],
            timestamp: Date.now()
        };
    }
}

module.exports = OnchainOS;
