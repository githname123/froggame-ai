/**
 * OEOE Game 配置文件
 * 所有地址从服务器 API 动态获取
 * 部署时修改服务器 .env 文件
 */

// 安全地获取 window 相关属性
function getServerUrl() {
    if (typeof window !== 'undefined' && window.location) {
        return window.location.origin || 'http://localhost:3001';
    }
    return 'http://localhost:3001';
}

function getWsUrl() {
    if (typeof window !== 'undefined' && window.location) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host || 'localhost:3001';
        return `${protocol}//${host}`;
    }
    return 'ws://localhost:3001';
}

const GAME_CONFIG = {
    // ============ 区块链配置 ============
    chain: {
        chainId: 196,
        chainName: 'X Layer',
        rpcUrl: 'https://rpc.xlayer.tech',
        blockExplorer: 'https://www.oklink.com/xlayer'
    },
    
    // ============ 合约地址（已填写）============
    contracts: {
        token: '0x4c225fb675c0c475b53381463782a7f741d59763',
        game: '0x187A6Ed9eFF6070C6588218BEFfdE822a06758aA',
        burn: '0x000000000000000000000000000000000000dEaD',
        dev: '0x23e9186ef00c6b423eef92c9e3a144bada5612cb'
    },
    
    // ============ 服务器配置 ============
    server: {
        url: getServerUrl(),
        wsUrl: getWsUrl()
    },
    
    // ============ 游戏配置 ============
    game: {
        // 轮次时长（秒）
        roundDuration: 60,
        // 食物列表
        foods: [
            { id: 0, name: '苹果', emoji: '🍎' },
            { id: 1, name: '香蕉', emoji: '🍌' },
            { id: 2, name: '蛋糕', emoji: '🍰' },
            { id: 3, name: '糖果', emoji: '🍬' },
            { id: 4, name: '鸡腿', emoji: '🍗' },
            { id: 5, name: '鱼', emoji: '🐟' },
            { id: 6, name: '虾', emoji: '🦐' },
            { id: 7, name: '螃蟹', emoji: '🦀' }
        ],
        // 经济参数
        economics: {
            rewardPercent: 90,  // 赢家奖励 90%
            burnPercent: 2,     // 销毁 2%
            devPercent: 8       // 开发费 8%
        },
        // 减伤机制
        damageReduction: {
            rank1: 0.10,    // 第1名 10%
            rank2_5: 0.05,  // 第2-5名 5%
            rank6_10: 0.03  // 第6-10名 3%
        }
    },
    
    // ============ 代币配置 ============
    token: {
        decimals: 9,  // OEOE 代币精度
        symbol: 'OEOE',
        name: 'OEOE Token'
    }
};

// 显式暴露到 window 对象（确保 index.html 能访问）
// 使用 var 确保在全局作用域
var GAME_CONFIG_GLOBAL = GAME_CONFIG;
if (typeof window !== 'undefined') {
    window.GAME_CONFIG = GAME_CONFIG;
    window.loadServerConfig = loadServerConfig;
    console.log('✅ GAME_CONFIG 已加载到 window');
}

// 动态获取服务器配置
async function loadServerConfig() {
    try {
        const response = await fetch(`${GAME_CONFIG.server.url}/api/config`);
        if (response.ok) {
            const serverConfig = await response.json();
            // 合并服务器配置
            if (serverConfig.contracts) {
                // 只更新空值
                if (!GAME_CONFIG.contracts.token && serverConfig.contracts.token) {
                    GAME_CONFIG.contracts.token = serverConfig.contracts.token;
                }
                if (!GAME_CONFIG.contracts.game && serverConfig.contracts.game) {
                    GAME_CONFIG.contracts.game = serverConfig.contracts.game;
                }
                if (!GAME_CONFIG.contracts.dev && serverConfig.contracts.dev) {
                    GAME_CONFIG.contracts.dev = serverConfig.contracts.dev;
                }
            }
            console.log('✅ 服务器配置已加载');
        }
    } catch (error) {
        console.warn('⚠️ 无法从服务器加载配置，使用默认配置');
    }
    return GAME_CONFIG;
}

// 导出配置
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GAME_CONFIG, loadServerConfig };
}
