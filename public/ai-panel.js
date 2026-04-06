/**
 * FrogGame AI Panel — Frontend interaction logic
 * 
 * Features:
 * - Real-time strategy recommendations
 * - Historical food win-rate charts (pure CSS bars)
 * - Natural language chat interface
 * - OnchainOS market data display
 */

const AI_PANEL = (() => {
    const API_BASE = window.location.origin;
    let chatHistory = [];
    let strategyRefreshTimer = null;
    let isOpen = false;

    // ==================== DOM Creation ====================
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'ai-panel';
        panel.innerHTML = `
            <div id="ai-panel-toggle" title="AI Assistant">
                <span>🤖</span>
            </div>
            <div id="ai-panel-content" class="ai-hidden">
                <div id="ai-panel-header">
                    <span>🤖 AI 策略顾问</span>
                    <button id="ai-panel-close">✕</button>
                </div>
                <div id="ai-tabs">
                    <button class="ai-tab active" data-tab="strategy">📊 策略</button>
                    <button class="ai-tab" data-tab="history">📈 历史</button>
                    <button class="ai-tab" data-tab="chat">💬 对话</button>
                </div>
                <div id="ai-tab-content">
                    <!-- Strategy Tab -->
                    <div id="ai-tab-strategy" class="ai-tab-pane active">
                        <div id="ai-strategy-loading" class="ai-loading">分析中...</div>
                        <div id="ai-strategy-content"></div>
                    </div>
                    <!-- History Tab -->
                    <div id="ai-tab-history" class="ai-tab-pane">
                        <div id="ai-history-loading" class="ai-loading">加载历史...</div>
                        <div id="ai-history-content"></div>
                    </div>
                    <!-- Chat Tab -->
                    <div id="ai-tab-chat" class="ai-tab-pane">
                        <div id="ai-chat-messages"></div>
                        <div id="ai-chat-input-area">
                            <input type="text" id="ai-chat-input" placeholder="随便问我... (例如 '帮我分析', '当前局势')" />
                            <button id="ai-chat-send">发送</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        bindEvents();
    }

    function bindEvents() {
        document.getElementById('ai-panel-toggle').addEventListener('click', togglePanel);
        document.getElementById('ai-panel-close').addEventListener('click', togglePanel);

        // Tabs
        document.querySelectorAll('.ai-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.ai-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.ai-tab-pane').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`ai-tab-${tab.dataset.tab}`).classList.add('active');

                if (tab.dataset.tab === 'strategy') refreshStrategy();
                if (tab.dataset.tab === 'history') refreshHistory();
            });
        });

        // Chat
        document.getElementById('ai-chat-send').addEventListener('click', sendChat);
        document.getElementById('ai-chat-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendChat();
        });
    }

    function togglePanel() {
        isOpen = !isOpen;
        const content = document.getElementById('ai-panel-content');
        const toggle = document.getElementById('ai-panel-toggle');
        if (isOpen) {
            content.classList.remove('ai-hidden');
            toggle.classList.add('ai-hidden');
            refreshStrategy();
            startAutoRefresh();
        } else {
            content.classList.add('ai-hidden');
            toggle.classList.remove('ai-hidden');
            stopAutoRefresh();
        }
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        strategyRefreshTimer = setInterval(refreshStrategy, 5000);
    }

    function stopAutoRefresh() {
        if (strategyRefreshTimer) { clearInterval(strategyRefreshTimer); strategyRefreshTimer = null; }
    }

    // ==================== Strategy Tab ====================
    async function refreshStrategy() {
        const loading = document.getElementById('ai-strategy-loading');
        const content = document.getElementById('ai-strategy-content');
        try {
            const res = await fetch(`${API_BASE}/api/ai/strategy`);
            const data = await res.json();
            loading.style.display = 'none';
            content.innerHTML = renderStrategy(data);
        } catch (err) {
            loading.textContent = '策略加载失败';
        }
    }

    function renderStrategy(data) {
        const { roundId, phase, totalPool, foodStats, foodEV, recommendations, unbettedFoods } = data;

        let html = `<div class="ai-section">
            <div class="ai-round-info">第 ${roundId} 轮 | ${phase} | 奖池: ${Math.floor(totalPool).toLocaleString()} OEOE</div>
        </div>`;

        // Betting distribution bars
        html += `<div class="ai-section"><div class="ai-section-title">投注分布</div>`;
        const maxBet = Math.max(...foodStats.map(f => f.totalBet), 1);
        for (const food of foodStats) {
            const pct = (food.totalBet / maxBet * 100).toFixed(0);
            const evData = foodEV.find(f => f.index === food.index);
            const evStr = evData ? (evData.ev > 0 ? `+${evData.ev}` : `${evData.ev}`) : '0';
            html += `<div class="ai-bar-row">
                <span class="ai-bar-label">${food.emoji}</span>
                <div class="ai-bar-track">
                    <div class="ai-bar-fill ${food.totalBet === 0 ? 'empty' : ''}" style="width: ${food.totalBet > 0 ? Math.max(pct, 5) : 0}%"></div>
                </div>
                <span class="ai-bar-value">${Math.floor(food.totalBet).toLocaleString()}</span>
                <span class="ai-bar-ev" title="Expected Value per 1 OEOE">${evStr}</span>
            </div>`;
        }
        html += `</div>`;

        // Recommendations
        if (recommendations.length > 0) {
            html += `<div class="ai-section"><div class="ai-section-title">AI 推荐</div>`;
            for (const rec of recommendations) {
                const icon = rec.type === 'opportunity' ? '🎯' : rec.type === 'warning' ? '⚠️' : rec.type === 'risk' ? '🔴' : '💡';
                html += `<div class="ai-rec ai-rec-${rec.type}">${icon} ${rec.message}</div>`;
            }
            html += `</div>`;
        }

        // Unbetted foods
        if (unbettedFoods && unbettedFoods.length > 0) {
            html += `<div class="ai-highlight">🎯 无人投注: ${unbettedFoods.map(f => f.emoji).join(' ')} — 最大收益潜力！</div>`;
        }

        return html;
    }

    // ==================== History Tab ====================
    async function refreshHistory() {
        const loading = document.getElementById('ai-history-loading');
        const content = document.getElementById('ai-history-content');
        try {
            const res = await fetch(`${API_BASE}/api/ai/history-analysis`);
            const data = await res.json();
            loading.style.display = 'none';
            content.innerHTML = renderHistory(data);
        } catch (err) {
            loading.textContent = '历史加载失败';
        }
    }

    function renderHistory(data) {
        const { totalRounds, contestedRounds, foodAnalysis, recentEatenSequence, disclaimer } = data;

        let html = `<div class="ai-section">
            <div class="ai-round-info">总计: ${totalRounds} 轮 | 有效竞争: ${contestedRounds} 轮</div>
        </div>`;

        // Recent sequence
        if (recentEatenSequence && recentEatenSequence.length > 0) {
            html += `<div class="ai-section"><div class="ai-section-title">最近被吃 (新→旧)</div>
                <div class="ai-sequence">${recentEatenSequence.join(' ')}</div></div>`;
        }

        // Food frequency chart
        html += `<div class="ai-section"><div class="ai-section-title">食物被吃频率</div>`;
        const maxCount = Math.max(...foodAnalysis.map(f => f.eatenCount), 1);
        for (const food of foodAnalysis) {
            const pct = (food.eatenCount / maxCount * 100).toFixed(0);
            const deviationStr = food.deviation > 0 ? `+${food.deviation}%` : `${food.deviation}%`;
            const deviationClass = Math.abs(food.deviation) > 20 ? 'ai-deviation-high' : '';
            html += `<div class="ai-bar-row">
                <span class="ai-bar-label">${food.emoji}</span>
                <div class="ai-bar-track">
                    <div class="ai-bar-fill history" style="width: ${Math.max(pct, 3)}%"></div>
                </div>
                <span class="ai-bar-value">${food.eatenCount}x</span>
                <span class="ai-bar-ev ${deviationClass}">${deviationStr}</span>
            </div>`;
        }
        html += `</div>`;

        html += `<div class="ai-disclaimer">${disclaimer}</div>`;
        return html;
    }

    // ==================== Chat Tab ====================
    async function sendChat() {
        const input = document.getElementById('ai-chat-input');
        const msg = input.value.trim();
        if (!msg) return;
        input.value = '';

        appendChatMessage('user', msg);

        try {
            const address = window.connectedAddress || null;
            const res = await fetch(`${API_BASE}/api/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg, address })
            });
            const data = await res.json();
            appendChatMessage('ai', data.reply);

            // Handle actions
            if (data.actions) {
                for (const action of data.actions) {
                    if (action.type === 'suggest_bet' && action.amount) {
                        const customBet = document.getElementById('custom-bet');
                        if (customBet) customBet.value = action.amount;
                    }
                }
            }
        } catch (err) {
            appendChatMessage('ai', '❌ 获取回复失败，请重试。');
        }
    }

    function appendChatMessage(role, text) {
        const container = document.getElementById('ai-chat-messages');
        const div = document.createElement('div');
        div.className = `ai-chat-msg ai-chat-${role}`;
        // Simple markdown-like formatting
        div.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        chatHistory.push({ role, text });
    }

    // ==================== Init ====================
    function init() {
        createPanel();
        injectStyles();
        // Add welcome message
        setTimeout(() => {
            appendChatMessage('ai', '🐸 欢迎使用 FrogGame AI！我可以帮你分析投注、查看历史和推荐策略。\n\n输入"帮助"查看功能，或输入"分析"获取当前局势分析。');
        }, 500);
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #ai-panel { position: fixed; bottom: 20px; right: 20px; z-index: 1000; font-family: 'Roboto', sans-serif; }
            #ai-panel-toggle { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 15px rgba(99,102,241,0.5); font-size: 24px; transition: transform 0.2s; }
            #ai-panel-toggle:hover { transform: scale(1.1); }
            #ai-panel-content { width: 380px; max-height: 520px; background: #1e293b; border: 1px solid #334155; border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden; }
            #ai-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: linear-gradient(135deg, #1e1b4b, #312e81); color: white; font-weight: bold; font-size: 14px; }
            #ai-panel-header button { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 18px; }
            #ai-tabs { display: flex; border-bottom: 1px solid #334155; }
            .ai-tab { flex: 1; padding: 8px; background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 12px; border-bottom: 2px solid transparent; transition: all 0.2s; }
            .ai-tab.active { color: #a78bfa; border-bottom-color: #a78bfa; }
            .ai-tab:hover { color: #c4b5fd; }
            #ai-tab-content { flex: 1; overflow-y: auto; }
            .ai-tab-pane { display: none; padding: 12px; }
            .ai-tab-pane.active { display: block; }
            .ai-hidden { display: none !important; }
            .ai-section { margin-bottom: 12px; }
            .ai-section-title { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
            .ai-round-info { font-size: 13px; color: #a78bfa; font-weight: bold; }
            .ai-bar-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; }
            .ai-bar-label { width: 24px; text-align: center; font-size: 16px; }
            .ai-bar-track { flex: 1; height: 16px; background: #0f172a; border-radius: 3px; overflow: hidden; }
            .ai-bar-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #a78bfa); border-radius: 3px; transition: width 0.3s; min-width: 0; }
            .ai-bar-fill.empty { background: #334155; }
            .ai-bar-fill.history { background: linear-gradient(90deg, #0891b2, #22d3ee); }
            .ai-bar-value { width: 60px; text-align: right; color: #e2e8f0; font-size: 11px; }
            .ai-bar-ev { width: 40px; text-align: right; color: #64748b; font-size: 10px; }
            .ai-deviation-high { color: #f97316 !important; font-weight: bold; }
            .ai-rec { padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; font-size: 12px; color: #e2e8f0; background: #0f172a; }
            .ai-rec-opportunity { border-left: 3px solid #22c55e; }
            .ai-rec-warning { border-left: 3px solid #eab308; }
            .ai-rec-strategy { border-left: 3px solid #6366f1; }
            .ai-rec-risk { border-left: 3px solid #ef4444; }
            .ai-highlight { background: linear-gradient(135deg, #1e1b4b, #312e81); padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #c4b5fd; margin-top: 8px; }
            .ai-sequence { font-size: 20px; letter-spacing: 4px; }
            .ai-disclaimer { font-size: 10px; color: #475569; margin-top: 8px; font-style: italic; }
            .ai-loading { text-align: center; color: #64748b; padding: 20px; font-size: 13px; }
            #ai-chat-messages { height: 300px; overflow-y: auto; padding: 8px; }
            .ai-chat-msg { margin-bottom: 8px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5; max-width: 90%; word-wrap: break-word; }
            .ai-chat-user { background: #312e81; color: #e2e8f0; margin-left: auto; text-align: right; }
            .ai-chat-ai { background: #0f172a; color: #e2e8f0; border: 1px solid #1e293b; }
            #ai-chat-input-area { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #334155; }
            #ai-chat-input { flex: 1; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; color: #e2e8f0; font-size: 12px; outline: none; }
            #ai-chat-input:focus { border-color: #6366f1; }
            #ai-chat-send { background: #6366f1; color: white; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 12px; font-weight: bold; }
            #ai-chat-send:hover { background: #818cf8; }
            @media (max-width: 768px) {
                #ai-panel-content { width: calc(100vw - 40px); max-height: 60vh; }
                #ai-panel { bottom: 10px; right: 10px; }
            }
        `;
        document.head.appendChild(style);
    }

    return { init };
})();

// Auto-init when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', AI_PANEL.init);
} else {
    AI_PANEL.init();
}
