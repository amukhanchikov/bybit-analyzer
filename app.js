/**
 * CONFIGURATION
 */
const Config = {
    API_URL: 'https://api.bybit.com',
    VERSION: '2.0.0', // App version
    ENDPOINTS: {
        INSTRUMENTS: '/v5/market/instruments-info?category=linear&limit=1000',
        TICKERS: '/v5/market/tickers?category=linear',
        KLINE: '/v5/market/kline'
    },
    STORAGE_KEYS: {
        FAVORITES: 'bybit_analyzer_favs_v2',
        CACHE_INSTRUMENTS: 'bybit_instruments_cache_v4',
        EXCLUDED: 'bybit_analyzer_excluded_v1',
        TIMEFRAME: 'bybit_analyzer_tf_v1'
    },
    DEFAULTS: {
        EXCLUDED: "BTC, ETH, ETHBTC, PAXG, RLUSD, SOL, USD1, USDC, USDE, XAUT",
        TIMEFRAME_VAL: 24,
        TIMEFRAME_TYPE: 'preset'
    },
    // Performance constants
    CONCURRENCY_LIMIT: 30,
    RETRY_DELAY_MS: 300,
    RETRY_MAX_ATTEMPTS: 3,
    CACHE_TTL: {
        INSTRUMENTS: 3600 * 1000,
        TICKERS: 15 * 1000
    }
};

/**
 * ERROR HANDLING & VALIDATION
 */
const ErrorHandler = {
    init() {
        window.addEventListener('unhandledrejection', (event) => {
            console.error('❌ Unhandled promise rejection:', event.reason);
            if (UI && UI.showError) {
                UI.showError(event.reason?.message || 'An unexpected error occurred.');
            }
            event.preventDefault();
        });

        window.addEventListener('error', (event) => {
            console.error('❌ Runtime error:', event.error);
            if (UI && UI.showError) UI.showError('An unexpected error occurred.');
        });
    },

    logError(context, error) {
        console.error(`❌ Error in ${context}:`, error);
    }
};

// Initialize listeners
ErrorHandler.init();

const Validator = {
    validateWatchlist(data) {
        if (!data || typeof data !== 'object') return { valid: false, error: 'Invalid JSON format' };

        const hasLong = data.long_watchlist && typeof data.long_watchlist === 'object';
        const hasShort = data.short_watchlist && typeof data.short_watchlist === 'object';

        if (!hasLong && !hasShort) {
            return { valid: false, error: 'Watchlist must contain "long_watchlist" or "short_watchlist"' };
        }
        return { valid: true };
    },

    validateTimeframe(val, unit) {
        const num = parseFloat(val);
        if (isNaN(num) || num <= 0) return { valid: false, error: 'Timeframe must be positive' };
        if (!['m', 'h', 'd'].includes(unit)) return { valid: false, error: 'Invalid unit' };

        // Calculate max hours (1 year approx)
        let hours = num;
        if (unit === 'm') hours /= 60;
        if (unit === 'd') hours *= 24;

        if (hours > 8760) return { valid: false, error: 'Timeframe cannot exceed 1 year' };
        return { valid: true, hours };
    }
};

/**
 * UTILITIES
 */
const Utils = {
    wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    debounce: (func, wait) => {
        let timeout;
        return function (...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), wait);
        };
    },
    getColorClass: (val) => val > 0 ? 'text-green-500' : (val < 0 ? 'text-red-500' : 'text-gray-400'),

    calculateMedian: (values) => {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    },

    async processWithConcurrency(items, concurrencyLimit, processFn, progressCallback) {
        const results = [];
        const queue = [...items];
        let processedCount = 0;
        const total = items.length;

        const worker = async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                try {
                    const result = await processFn(item);
                    if (result !== null) results.push(result);
                } catch (e) {
                    // Log but don't stop the whole process
                    // ErrorHandler.logError(`process item`, e); 
                    // Keeping silent to avoid console spam during massive processing, 
                    // or usage of a specific log level if implemented.
                } finally {
                    processedCount++;
                    if (progressCallback) progressCallback(processedCount, total);
                }
            }
        };

        const workers = Array(concurrencyLimit).fill(null).map(() => worker());
        await Promise.all(workers);
        return results;
    },

    // Convert hours to appropriate API interval and limit
    getChartParams(hours) {
        let interval, limit;

        // Logic: Try to get around 100-200 candles for the view
        if (hours <= 1) {
            interval = '1'; // 1 min candles
            limit = Math.min(200, hours * 60);
        } else if (hours <= 6) {
            interval = '5'; // 5 min candles
            limit = Math.ceil((hours * 60) / 5);
        } else if (hours <= 24) {
            interval = '15'; // 15 min candles
            limit = Math.ceil((hours * 60) / 15);
        } else if (hours <= 168) { // 7 days
            interval = '60'; // 1 hour candles
            limit = hours;
        } else { // > 7 days
            interval = 'D'; // Daily
            limit = Math.ceil(hours / 24);
        }

        if (limit > 1000) limit = 1000;
        if (limit < 20) limit = 20; // Minimum candles for context

        return { interval, limit };
    },

};

/**
 * API SERVICE
 */
const Api = {
    async fetchInstruments() {
        const cached = sessionStorage.getItem(Config.STORAGE_KEYS.CACHE_INSTRUMENTS);
        if (cached) {
            const { ts, data } = JSON.parse(cached);
            if (Date.now() - ts < 3600 * 1000) return data;
        }

        let list = [];
        let cursor = '';
        try {
            do {
                const url = `${Config.API_URL}${Config.ENDPOINTS.INSTRUMENTS}${cursor ? `&cursor=${cursor}` : ''}`;
                const res = await fetch(url);
                const json = await res.json();
                if (json.retCode !== 0) throw new Error(json.retMsg);

                const activeItems = json.result.list
                    .filter(i => i.status === 'Trading' && i.symbol.endsWith('USDT'))
                    .map(i => ({
                        symbol: i.symbol,
                        launchTime: parseInt(i.launchTime),
                        tickSize: i.priceFilter.tickSize
                    }));

                list.push(...activeItems);
                cursor = json.result.nextPageCursor;
            } while (cursor);

            sessionStorage.setItem(Config.STORAGE_KEYS.CACHE_INSTRUMENTS, JSON.stringify({
                ts: Date.now(),
                data: list
            }));
            return list;
        } catch (e) { throw new Error("Failed to fetch instruments: " + e.message); }
    },

    // Cache tickers for 15 seconds to prevent spamming
    tickersCache: { data: null, ts: 0 },

    async fetchAllTickers() {
        if (this.tickersCache.data && (Date.now() - this.tickersCache.ts < 15000)) {
            return this.tickersCache.data;
        }
        const res = await fetch(`${Config.API_URL}${Config.ENDPOINTS.TICKERS}`);
        const json = await res.json();
        if (json.retCode !== 0) throw new Error(json.retMsg);

        this.tickersCache.data = json.result.list;
        this.tickersCache.ts = Date.now();
        return json.result.list;
    },

    async fetchKline(symbol, interval, start) {
        let retries = Config.RETRY_MAX_ATTEMPTS;
        while (retries > 0) {
            try {
                const url = `${Config.API_URL}${Config.ENDPOINTS.KLINE}?category=linear&symbol=${symbol}&interval=${interval}&start=${start}&limit=1`;
                const res = await fetch(url);
                if (!res.ok) throw new Error('Network error');
                const json = await res.json();
                if (json.retCode !== 0) throw new Error('API error');
                return json.result.list.length > 0 ? json.result.list[0] : null;
            } catch (e) {
                retries--;
                if (retries > 0) await Utils.wait(Config.RETRY_DELAY_MS);
                else ErrorHandler.logError('fetchKline', e);
            }
        }
        return null;
    },

    // Fetch History for Chart
    async fetchHistory(symbol, interval, limit) {
        let retries = Config.RETRY_MAX_ATTEMPTS;
        while (retries > 0) {
            try {
                const url = `${Config.API_URL}${Config.ENDPOINTS.KLINE}?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
                const res = await fetch(url);

                if (!res.ok) throw new Error(`Network error: ${res.status}`);

                const json = await res.json();

                if (json.retCode !== 0) {
                    throw new Error(json.retMsg || "Bybit API returned error");
                }

                if (!json.result || !json.result.list) {
                    return [];
                }

                return json.result.list.map(k => ({
                    time: parseInt(k[0]) / 1000, // Unix Timestamp (seconds)
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                })).sort((a, b) => a.time - b.time);

            } catch (e) {
                retries--;
                if (retries === 0) {
                    ErrorHandler.logError('fetchHistory', e);
                    throw e;
                }
                await Utils.wait(Config.RETRY_DELAY_MS);
            }
        }
    }
};

/**
 * UI RENDERER
 */
const UI = {
    els: {
        app: document.getElementById('app'),
        controls: document.getElementById('controls'),
        loader: document.getElementById('loader'),
        loaderText: document.getElementById('loader-text'),
        progressBar: document.getElementById('progress-bar'),
        progressStats: document.getElementById('progress-stats'),
        errorBox: document.getElementById('error-box'),
        resultsArea: document.getElementById('results-area'),
        timeButtons: document.querySelectorAll('#timeframe-buttons button'),
        buttonsContainer: document.getElementById('buttons-container'),
        // ADDED: Wrapper for just the buttons to target opacity
        buttonsWrapper: document.getElementById('timeframe-buttons'),
        customContainer: document.getElementById('custom-input-container'),
        customVal: document.getElementById('custom-time-val'),
        customUnit: document.getElementById('custom-time-unit'),
        customLabel: document.getElementById('custom-label'),
        favList: document.getElementById('favorites-list'),
        fileInput: document.getElementById('file-upload'),
        analyzeWatchlistBtn: document.getElementById('btn-analyze-watchlist'),
        btnSaveFav: document.getElementById('btn-save-fav'),
        excludeInput: document.getElementById('exclude-input'),
        btnResetExclude: document.getElementById('btn-reset-exclude'), // NEW
        // Active File Els
        activePanel: document.getElementById('active-watchlist-panel'),
        activeFilename: document.getElementById('active-filename'),
        btnClearActive: document.getElementById('btn-clear-active'),
        // Modal Els
        modalBackdrop: document.getElementById('modal-backdrop'),
        modalContent: document.getElementById('modal-content'),
        modalList: document.getElementById('modal-list'),
        modalCountDisplay: document.getElementById('modal-count-display'),
        closeModalBtn: document.getElementById('btn-close-modal'),
        modalTitle: document.getElementById('modal-title'),
        modalDesc: document.getElementById('modal-desc'),
        modalBodyList: document.getElementById('modal-body-list'),
        modalFooter: document.getElementById('modal-footer'),
        // Chart Modal Els
        chartModal: document.getElementById('chart-modal'),
        chartPopupContent: document.getElementById('chart-popup-content'),
        chartSymbol: document.getElementById('chart-symbol'),
        chartBadge: document.getElementById('chart-timeframe-badge'),
        chartContainer: document.getElementById('chart-container'),
        chartLoading: document.getElementById('chart-loading'),
        btnCloseChart: document.getElementById('btn-close-chart'),
        chartTooltip: document.getElementById('chart-tooltip')
    },

    // --- Charting ---
    chartInstance: null,
    candlestickSeries: null,

    initChart() {
        if (typeof LightweightCharts === 'undefined') {
            throw new Error("Charting library not loaded. Check internet connection.");
        }

        if (this.chartInstance) {
            // Resize to ensure it fits current container state
            const rect = this.els.chartContainer.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                this.chartInstance.applyOptions({ height: rect.height, width: rect.width });
            }
            return;
        }

        const chartOptions = {
            layout: {
                background: { type: 'solid', color: '#111827' }, // gray-900
                textColor: '#9ca3af', // gray-400
            },
            grid: {
                vertLines: { color: '#1f2937' }, // gray-800
                horzLines: { color: '#1f2937' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
            rightPriceScale: {
                borderColor: '#374151',
            },
            timeScale: {
                borderColor: '#374151',
                timeVisible: true,
                secondsVisible: false,
            },
            autoSize: true, // Use built-in autoSize if supported or handle manually
        };

        this.chartInstance = LightweightCharts.createChart(this.els.chartContainer, chartOptions);
        // FIX: v4 API change
        this.candlestickSeries = this.chartInstance.addSeries(LightweightCharts.CandlestickSeries, {
            upColor: '#22c55e', // green-500
            downColor: '#ef4444', // red-500
            borderVisible: false,
            wickUpColor: '#22c55e',
            wickDownColor: '#ef4444',
        });

        // Auto resize observer
        new ResizeObserver(entries => {
            if (entries.length === 0 || entries[0].target !== this.els.chartContainer) { return; }
            const newRect = entries[0].contentRect;
            if (this.chartInstance) {
                this.chartInstance.applyOptions({ height: newRect.height, width: newRect.width });
            }
        }).observe(this.els.chartContainer);

        // Tooltip
        this.chartInstance.subscribeCrosshairMove(param => {
            if (param.point === undefined || !param.time || param.point.x < 0 || param.point.x > this.els.chartContainer.clientWidth || param.point.y < 0 || param.point.y > this.els.chartContainer.clientHeight) {
                this.els.chartTooltip.style.display = 'none';
            } else {
                const dateStr = new Date(param.time * 1000).toLocaleString('en-GB', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const data = param.seriesData.get(this.candlestickSeries);
                if (data) {
                    const price = data.value !== undefined ? data.value : data.close;
                    this.els.chartTooltip.style.display = 'block';
                    this.els.chartTooltip.innerHTML = `
                        <div class="font-bold text-white mb-1">${dateStr}</div>
                        <div class="flex justify-between gap-4"><span class="text-gray-400">Open</span> <span>${data.open}</span></div>
                        <div class="flex justify-between gap-4"><span class="text-gray-400">High</span> <span>${data.high}</span></div>
                        <div class="flex justify-between gap-4"><span class="text-gray-400">Low</span> <span>${data.low}</span></div>
                        <div class="flex justify-between gap-4"><span class="text-gray-400">Close</span> <span class="${data.close >= data.open ? 'text-green-400' : 'text-red-400'}">${data.close}</span></div>
                    `;
                }
            }
        });
    },

    async showChart(symbol, hours) {
        try {
            // 1. Show Modal UI
            this.els.chartModal.classList.remove('hidden');
            this.els.chartModal.classList.add('flex');

            requestAnimationFrame(() => {
                this.els.chartModal.classList.remove('opacity-0');
                // Animation for popup content
                this.els.chartPopupContent.classList.remove('scale-95');
                this.els.chartPopupContent.classList.add('scale-100');
            });

            this.els.chartSymbol.textContent = symbol;
            this.els.chartBadge.textContent = hours < 24 ? `${hours}h` : (hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`);
            this.els.chartLoading.classList.remove('hidden');
            this.els.chartLoading.classList.add('flex');

            // 2. Initialize Chart
            this.initChart();

            // Clear previous data
            if (this.candlestickSeries) {
                this.candlestickSeries.setData([]);
            }

            // 3. Calc Params
            const { interval, limit } = Utils.getChartParams(hours);

            // 4. Fetch Data
            const data = await Api.fetchHistory(symbol, interval, limit);

            if (!data || data.length === 0) {
                alert(`No historical data found for ${symbol}`);
                this.closeChart();
                return;
            }

            // 5. Update Chart
            if (this.candlestickSeries) {
                this.candlestickSeries.setData(data);

                // Dynamic Precision Logic
                try {
                    const instruments = await Api.fetchInstruments();
                    const inst = instruments.find(i => i.symbol === symbol);
                    if (inst && inst.tickSize) {
                        // FIX: '0.10' -> '0.1' regarding precision
                        let tsStr = inst.tickSize;
                        if (tsStr.includes('.')) {
                            tsStr = tsStr.replace(/0+$/, '');
                            if (tsStr.endsWith('.')) tsStr = tsStr.slice(0, -1);
                        }

                        const tickSize = parseFloat(inst.tickSize);
                        const precision = (tsStr.split('.')[1] || '').length;

                        this.candlestickSeries.applyOptions({
                            priceFormat: {
                                type: 'price',
                                precision: precision,
                                minMove: tickSize,
                            },
                        });
                    }
                } catch (e) {
                    console.warn("Could not set exact precision:", e);
                }

                this.chartInstance.timeScale().fitContent();
            }

        } catch (e) {
            console.error("Show Chart Error:", e);
            alert("Error opening chart: " + e.message + "\nCheck console for details.");
            this.closeChart();
        } finally {
            this.els.chartLoading.classList.add('hidden');
            this.els.chartLoading.classList.remove('flex');
        }
    },

    closeChart() {
        this.els.chartModal.classList.add('opacity-0');
        // Reverse animation
        this.els.chartPopupContent.classList.remove('scale-100');
        this.els.chartPopupContent.classList.add('scale-95');

        setTimeout(() => {
            this.els.chartModal.classList.add('hidden');
            this.els.chartModal.classList.remove('flex');
            // Reset tooltips
            this.els.chartTooltip.style.display = 'none';
        }, 300);
    },

    // --- Generic UI ---

    setLoading(isLoading, text = 'Loading...') {
        if (isLoading) {
            this.els.controls.classList.add('opacity-50', 'pointer-events-none');
            this.els.loader.classList.remove('hidden');
            this.els.loader.classList.add('flex');
            this.els.loaderText.textContent = text;
            this.els.resultsArea.classList.add('hidden');
            this.els.errorBox.classList.add('hidden');
            this.updateProgress(0, 0);
        } else {
            this.els.controls.classList.remove('opacity-50', 'pointer-events-none');
            this.els.loader.classList.add('hidden');
            this.els.loader.classList.remove('flex');
        }
    },

    updateProgress(current, total) {
        if (this.progressReq) cancelAnimationFrame(this.progressReq);
        this.progressReq = requestAnimationFrame(() => {
            const pct = total > 0 ? (current / total) * 100 : 0;
            this.els.progressBar.style.width = `${pct}%`;
            this.els.progressStats.textContent = total > 0 ? `${current} / ${total}` : '';
        });
    },

    showError(msg) {
        this.els.errorBox.textContent = msg;
        this.els.errorBox.classList.remove('hidden');
        this.setLoading(false);
    },

    showResults() { this.els.resultsArea.classList.remove('hidden'); },
    clearResults() { this.els.resultsArea.innerHTML = ''; },

    // --- Active State Logic ---
    updateActiveFileUI(filename, isReady, isSaved) {
        if (isReady && filename) {
            this.els.activePanel.classList.remove('hidden');
            this.els.activePanel.classList.add('flex');
            this.els.activeFilename.textContent = filename;
            this.els.analyzeWatchlistBtn.disabled = false;

            if (isSaved) {
                this.els.btnSaveFav.disabled = true;
                this.els.btnSaveFav.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> Saved`;
                this.els.btnSaveFav.classList.add('text-green-500', 'opacity-50', 'cursor-not-allowed');
                this.els.btnSaveFav.classList.remove('text-yellow-500', 'hover:text-yellow-400');
            } else {
                this.els.btnSaveFav.disabled = false;
                this.els.btnSaveFav.innerHTML = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-3.125L5 18V4z"></path></svg> Save Current`;
                this.els.btnSaveFav.classList.remove('text-green-500', 'opacity-50', 'cursor-not-allowed');
                this.els.btnSaveFav.classList.add('text-yellow-500', 'hover:text-yellow-400');
            }
        } else {
            this.els.activePanel.classList.add('hidden');
            this.els.activePanel.classList.remove('flex');
            this.els.analyzeWatchlistBtn.disabled = true;
            this.els.btnSaveFav.disabled = true;
            this.els.fileInput.value = '';
        }
    },

    // --- Modal Logic ---
    showModal(type, data) {
        if (type === 'ignored') {
            this.els.modalTitle.textContent = 'Ignored Symbols';
            this.els.modalDesc.textContent = 'Excluded from analysis based on your filter';
            this.els.modalBodyList.classList.remove('hidden');
            this.els.modalFooter.classList.remove('hidden');

            this.els.modalList.innerHTML = '';
            data.forEach(sym => {
                const tag = document.createElement('span');
                tag.className = 'bg-gray-700 text-gray-300 text-xs font-medium px-2.5 py-1 rounded border border-gray-600';
                tag.textContent = sym.replace('USDT', ''); // Already stripping USDT
                this.els.modalList.appendChild(tag);
            });
            this.els.modalCountDisplay.textContent = `Total: ${data.length}`;

            this.els.modalBackdrop.classList.remove('hidden');
            this.els.modalBackdrop.classList.add('flex');

            requestAnimationFrame(() => {
                this.els.modalBackdrop.classList.remove('opacity-0');
                this.els.modalContent.classList.remove('scale-95');
                this.els.modalContent.classList.add('scale-100');
            });
        }
    },

    closeModal() {
        this.els.modalBackdrop.classList.add('opacity-0');
        this.els.modalContent.classList.remove('scale-100');
        this.els.modalContent.classList.add('scale-95');
        setTimeout(() => {
            this.els.modalBackdrop.classList.add('hidden');
            this.els.modalBackdrop.classList.remove('flex');
        }, 300);
    },

    renderCard(title, subtitle, data, ignoredSymbols = [], majorMovers = null, currentHours) {
        const tpl = document.getElementById('tpl-summary-card').content.cloneNode(true);

        const values = data.map(d => d.change);
        const sum = values.reduce((a, b) => a + b, 0);
        const avg = values.length ? sum / values.length : 0;
        const median = Utils.calculateMedian(values);
        const gainers = values.filter(v => v > 0).length;
        const losers = values.filter(v => v < 0).length;

        tpl.querySelector('.card-title').textContent = title;
        tpl.querySelector('.card-subtitle').textContent = subtitle;

        const avgEl = tpl.querySelector('.card-avg');
        avgEl.textContent = `${avg > 0 ? '+' : ''}${avg.toFixed(2)}%`;
        avgEl.className = `text-xl font-bold card-avg ${Utils.getColorClass(avg)}`;

        const medEl = tpl.querySelector('.card-median');
        medEl.textContent = `${median > 0 ? '+' : ''}${median.toFixed(2)}%`;
        medEl.className = `text-xl font-bold card-median ${Utils.getColorClass(median)}`;

        tpl.querySelector('.card-count').textContent = data.length;

        const ignoredCount = ignoredSymbols.length;
        const ignoredBtn = tpl.querySelector('.card-ignored');
        ignoredBtn.textContent = ignoredCount;

        const ignoredBtnContainer = tpl.querySelector('.card-ignored-btn');
        const ignoredIcon = ignoredBtnContainer.querySelector('.ignored-icon');

        if (ignoredCount > 0) {
            ignoredBtnContainer.disabled = false;
            ignoredBtnContainer.classList.add('cursor-pointer', 'hover:bg-gray-700', 'hover:border-gray-500');
            ignoredBtnContainer.classList.remove('opacity-50', 'cursor-default');
            ignoredIcon.classList.remove('opacity-0');
            ignoredIcon.classList.add('opacity-100', 'text-blue-400');
            ignoredBtnContainer.addEventListener('click', () => this.showModal('ignored', ignoredSymbols));
        } else {
            ignoredBtnContainer.disabled = true;
            ignoredBtnContainer.classList.add('opacity-50', 'cursor-default');
            ignoredBtnContainer.classList.remove('hover:bg-gray-700', 'hover:border-gray-500', 'cursor-pointer');
            ignoredIcon.classList.add('opacity-0');
            ignoredIcon.classList.remove('opacity-100');
        }

        tpl.querySelector('.card-gainers').textContent = gainers;
        tpl.querySelector('.card-losers').textContent = losers;

        if (majorMovers && majorMovers.length > 0) {
            const moversContainer = tpl.querySelector('.card-major-movers');
            moversContainer.classList.remove('hidden');
            majorMovers.forEach(m => {
                const div = document.createElement('div');
                div.className = 'bg-gray-900/50 p-3 rounded-lg border border-gray-700 text-center cursor-pointer hover:bg-gray-800 hover:border-gray-500 transition-all active:scale-95';
                div.innerHTML = `
                    <div class="text-sm text-gray-400 font-bold mb-1">${m.symbol.replace('USDT', '')}</div>
                    <div class="text-lg font-bold ${Utils.getColorClass(m.change)}">${m.change > 0 ? '+' : ''}${m.change}%</div>
                `;
                div.addEventListener('click', () => {
                    this.showChart(m.symbol, currentHours);
                });
                moversContainer.appendChild(div);
            });
        }

        const tablesContainer = tpl.querySelector('.card-tables');

        if (data.length <= 10) {
            // UPDATED: Removed logic needs to match new HTML classes
            tablesContainer.classList.remove('grid-cols-1', 'min-[550px]:grid-cols-2');
            const sortedData = [...data].sort((a, b) => b.change - a.change);
            tablesContainer.appendChild(this.createTable('📈 Performance', sortedData, currentHours));
        } else {
            const gainersData = [...data].sort((a, b) => b.change - a.change).slice(0, 10);
            // CHANGED ICON HERE (Swapped to Chart)
            tablesContainer.appendChild(this.createTable('📈 Top 10 Gainers', gainersData, currentHours));

            const losersData = [...data].sort((a, b) => a.change - b.change).slice(0, 10);
            tablesContainer.appendChild(this.createTable('📉 Top 10 Losers', losersData, currentHours));
        }

        return tpl.firstElementChild;
    },

    createTable(title, rowsData, currentHours) {
        const tpl = document.getElementById('tpl-table').content.cloneNode(true);
        tpl.querySelector('.table-header-title').innerHTML = title;
        const tbody = tpl.querySelector('.table-body');
        const fragment = document.createDocumentFragment();

        rowsData.forEach(item => {
            const row = document.getElementById('tpl-row').content.cloneNode(true);

            // REMOVE USDT FROM DISPLAY ONLY
            row.querySelector('.row-symbol').textContent = item.symbol.replace('USDT', '');
            row.querySelector('.row-link').href = `https://www.bybit.com/trade/usdt/${item.symbol}`;

            // Add Data Attribute for Event Delegation
            const chartBtn = row.querySelector('.btn-chart');
            chartBtn.dataset.symbol = item.symbol;

            const changeEl = row.querySelector('.row-change');
            changeEl.textContent = `${item.change > 0 ? '+' : ''}${item.change.toFixed(2)}%`;
            changeEl.className = `px-2 py-2 text-right font-bold row-change ${Utils.getColorClass(item.change)}`;

            fragment.appendChild(row);
        });

        tbody.appendChild(fragment);

        // Event Delegation
        tbody.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-chart');
            if (btn) {
                e.stopPropagation();
                this.showChart(btn.dataset.symbol, currentHours);
            }
        });

        return tpl;
    }
};

/**
 * MAIN LOGIC
 */
class Analyzer {
    constructor() {
        this.watchlists = null;
        this.currentFile = null;
        this.activeFavName = null;
        this.initListeners();
        this.renderFavorites();
        this.restoreSettings(); // Restore Exclude & Timeframe
    }

    // Restore saved settings from localStorage
    restoreSettings() {
        // 1. Restore Excluded Symbols
        const savedExcluded = localStorage.getItem(Config.STORAGE_KEYS.EXCLUDED);
        // Set value or default
        const valToSet = savedExcluded !== null ? savedExcluded : Config.DEFAULTS.EXCLUDED;
        UI.els.excludeInput.value = valToSet;

        // Check reset button state
        this.updateResetButtonState(valToSet);

        // 2. Restore Timeframe
        try {
            const savedTF = JSON.parse(localStorage.getItem(Config.STORAGE_KEYS.TIMEFRAME));
            if (savedTF && savedTF.type) {
                if (savedTF.type === 'preset') {
                    this.selectTimeframe(savedTF.val);
                } else if (savedTF.type === 'custom') {
                    UI.els.customVal.value = savedTF.val;
                    UI.els.customUnit.value = savedTF.unit;
                    this.handleCustomInput(); // Trigger state update
                }
            } else {
                // Default if no storage
                this.selectTimeframe(Config.DEFAULTS.TIMEFRAME_VAL);
            }
        } catch (e) {
            this.selectTimeframe(Config.DEFAULTS.TIMEFRAME_VAL);
        }
    }

    updateResetButtonState(currentVal) {
        // Normalize strings for comparison (trim whitespace)
        const isDefault = currentVal.trim() === Config.DEFAULTS.EXCLUDED.trim();
        if (isDefault) {
            UI.els.btnResetExclude.classList.add('hidden');
        } else {
            UI.els.btnResetExclude.classList.remove('hidden');
        }
    }

    initListeners() {
        UI.els.timeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectTimeframe(btn.dataset.val);
                UI.els.customVal.value = '';
                this.updateCustomInputState(false);
            });
        });

        [UI.els.customVal, UI.els.customUnit].forEach(el => {
            el.addEventListener('input', () => this.handleCustomInput());
            el.addEventListener('focus', () => this.handleCustomInput());
        });

        // Listen for changes in Exclude Input (Debounced)
        const debouncedSave = Utils.debounce((val) => {
            localStorage.setItem(Config.STORAGE_KEYS.EXCLUDED, val);
            this.updateResetButtonState(val);
        }, 500);

        UI.els.excludeInput.addEventListener('input', (e) => {
            debouncedSave(e.target.value);
            // Optionally update UI immediately if needed, but here we just wait for storage save
        });

        // Reset Button Listener
        UI.els.btnResetExclude.addEventListener('click', () => {
            const defaultVal = Config.DEFAULTS.EXCLUDED;
            UI.els.excludeInput.value = defaultVal;
            localStorage.setItem(Config.STORAGE_KEYS.EXCLUDED, defaultVal);
            this.updateResetButtonState(defaultVal);
        });

        document.getElementById('btn-analyze-market').addEventListener('click', () => this.runAnalysis('market'));
        UI.els.analyzeWatchlistBtn.addEventListener('click', () => this.runAnalysis('watchlist'));

        // File Upload
        UI.els.fileInput.addEventListener('change', (e) => this.handleFileUpload(e.target.files[0]));

        // Clear Active Button
        UI.els.btnClearActive.addEventListener('click', () => this.clearActiveFile());

        // Save Favorite Button
        UI.els.btnSaveFav.addEventListener('click', () => this.saveFavorite());

        // Modal listeners
        UI.els.closeModalBtn.addEventListener('click', () => UI.closeModal());
        UI.els.modalBackdrop.addEventListener('click', (e) => {
            if (e.target === UI.els.modalBackdrop) UI.closeModal();
        });

        // Chart Modal Listeners
        UI.els.btnCloseChart.addEventListener('click', () => UI.closeChart());
        // Add listener to close when clicking outside popup content
        UI.els.chartModal.addEventListener('click', (e) => {
            // Check if clicked element is the backdrop (chart-modal itself)
            if (e.target === UI.els.chartModal) {
                UI.closeChart();
            }
        });
    }

    handleCustomInput() {
        UI.els.timeButtons.forEach(b => b.classList.remove('btn-active'));
        this.selectedHours = null;
        this.updateCustomInputState(true);

        // Save custom timeframe state
        const val = UI.els.customVal.value;
        const unit = UI.els.customUnit.value;
        if (val) {
            localStorage.setItem(Config.STORAGE_KEYS.TIMEFRAME, JSON.stringify({
                type: 'custom',
                val: val,
                unit: unit
            }));
        }
    }

    updateCustomInputState(isActive) {
        const inputs = [UI.els.customVal, UI.els.customUnit];
        inputs.forEach(el => {
            if (isActive) {
                el.classList.add('input-active');
                el.classList.remove('border-gray-600');
            } else {
                el.classList.remove('input-active');
                el.classList.add('border-gray-600');
            }
        });

        if (isActive) {
            UI.els.customLabel.classList.add('text-blue-500');
            UI.els.customLabel.classList.remove('text-gray-500');
        } else {
            UI.els.customLabel.classList.remove('text-blue-500');
            UI.els.customLabel.classList.add('text-gray-500');
        }

        // CHANGED: Target only the buttons wrapper, not the container with the H2
        if (isActive) {
            UI.els.buttonsWrapper.classList.add('section-dimmed');
            UI.els.customContainer.classList.remove('section-dimmed');
        } else {
            UI.els.buttonsWrapper.classList.remove('section-dimmed');
            UI.els.customContainer.classList.add('section-dimmed');
        }
    }

    selectTimeframe(val) {
        UI.els.timeButtons.forEach(b => {
            if (b.dataset.val == val) b.classList.add('btn-active');
            else b.classList.remove('btn-active');
        });
        this.selectedHours = parseFloat(val);
        this.updateCustomInputState(false);

        // Save preset timeframe state
        localStorage.setItem(Config.STORAGE_KEYS.TIMEFRAME, JSON.stringify({
            type: 'preset',
            val: val
        }));
    }

    getTimeframeConfig() {
        let hours = this.selectedHours;
        if (!hours) {
            const val = parseFloat(UI.els.customVal.value);
            const unit = UI.els.customUnit.value;

            const validation = Validator.validateTimeframe(val, unit);
            if (!validation.valid) throw new Error(validation.error);

            hours = validation.hours;
        }
        return { hours, is24h: hours === 24 };
    }

    async handleFileUpload(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                const validation = Validator.validateWatchlist(data);

                if (!validation.valid) {
                    alert(`❌ ${validation.error}`);
                    this.clearActiveFile();
                    return;
                }

                this.watchlists = data;
                this.currentFile = file.name;
                this.updateActiveState(true);
            } catch (err) {
                alert('Invalid JSON');
                ErrorHandler.logError('handleFileUpload', err);
            }
        };
        reader.readAsText(file);
    }

    clearActiveFile() {
        this.watchlists = null;
        this.currentFile = null;
        this.updateActiveState(false);
    }

    updateActiveState(hasFile) {
        const isFav = this.getFavs().some(f => f.name === this.currentFile);
        UI.updateActiveFileUI(this.currentFile, hasFile, isFav);
        this.renderFavorites();
    }

    async runAnalysis(mode) {
        try {
            const { hours, is24h } = this.getTimeframeConfig();

            // Generate simplified time label
            const timeLabel = this.generateTimeLabel(hours);

            UI.clearResults();
            UI.setLoading(true, `Preparing ${mode} analysis (${timeLabel})...`);

            // FETCH INSTRUMENTS
            const instrumentsData = await Api.fetchInstruments();
            const launchTimeMap = new Map(instrumentsData.map(i => [i.symbol, i.launchTime]));

            // DETERMINE SYMBOLS TO ANALYZE
            const symbolsToAnalyze = this.getSymbolsToAnalyze(mode, instrumentsData);

            if (symbolsToAnalyze.length === 0) throw new Error("No symbols found");

            const cutoffTime = Date.now() - (hours * 3600 * 1000);

            UI.setLoading(true, `Fetching data for ${symbolsToAnalyze.length} symbols...`);

            let results = [];

            if (is24h) {
                const allTickers = await Api.fetchAllTickers();
                const tickerMap = new Map(allTickers.map(t => [t.symbol, t]));
                results = this.processTickerData(symbolsToAnalyze, tickerMap, launchTimeMap, cutoffTime);
            } else {
                results = await this.processKlineData(symbolsToAnalyze, hours, launchTimeMap, cutoffTime);
            }

            UI.setLoading(false);
            UI.showResults();

            this.renderAnalysisResults(mode, results, symbolsToAnalyze, timeLabel, hours);

        } catch (e) { UI.showError(e.message); }
    }

    // --- Helper Methods ---

    generateTimeLabel(hours) {
        if (hours < 1) {
            return `${Math.round(hours * 60)} Minutes`;
        } else if (hours >= 24 && hours % 24 === 0) {
            const days = hours / 24;
            return `${days} ${days === 1 ? 'Day' : 'Days'}`;
        } else {
            return `${parseFloat(hours.toFixed(2))} Hours`;
        }
    }

    getSymbolsToAnalyze(mode, instrumentsData) {
        if (mode === 'market') {
            // OPTIMIZED: Cache excluded set until changed? For now, clean parsing is enough.
            const excludeInput = document.getElementById('exclude-input').value
                .toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
            const excludedSet = new Set(excludeInput);

            const list = instrumentsData
                .map(i => i.symbol)
                .filter(s => !excludedSet.has(s.replace('USDT', '')));

            // Ensure major symbols are present
            ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].forEach(m => {
                if (!list.includes(m)) list.push(m);
            });
            return list;
        } else {
            if (!this.watchlists) throw new Error("No watchlist loaded");
            const combined = new Set();
            if (this.watchlists.long_watchlist) Object.keys(this.watchlists.long_watchlist).forEach(k => combined.add(k));
            if (this.watchlists.short_watchlist) Object.keys(this.watchlists.short_watchlist).forEach(k => combined.add(k));
            return Array.from(combined);
        }
    }

    processTickerData(symbols, tickerMap, launchTimeMap, cutoffTime) {
        return symbols.map(sym => {
            const t = tickerMap.get(sym);
            const launchTime = launchTimeMap.get(sym);
            if (launchTime && launchTime > cutoffTime) return null;
            return t ? { symbol: sym, change: parseFloat(parseFloat(t.price24hPcnt * 100).toFixed(2)) } : null;
        }).filter(Boolean);
    }

    async processKlineData(symbols, hours, launchTimeMap, cutoffTime) {
        const now = new Date();
        const startTime = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()) - (hours * 3600 * 1000);

        let interval;
        if (hours <= 24) interval = '5';
        else if (hours <= 720) interval = '60';
        else interval = 'D';

        const tickerMap = new Map((await Api.fetchAllTickers()).map(t => [t.symbol, t]));

        return Utils.processWithConcurrency(symbols, Config.CONCURRENCY_LIMIT, async (sym) => {
            const launchTime = launchTimeMap.get(sym);
            if (launchTime && launchTime > cutoffTime) return null;

            const ticker = tickerMap.get(sym);
            if (!ticker) return null;

            const kline = await Api.fetchKline(sym, interval, startTime);
            if (!kline) return null;

            const candleTime = parseInt(kline[0]);
            let tolerance;
            switch (interval) {
                case '5': tolerance = 5 * 60 * 1000 * 4; break;
                case '60': tolerance = 2 * 60 * 60 * 1000; break;
                case 'D': tolerance = 3 * 24 * 60 * 60 * 1000; break;
                default: tolerance = 60 * 60 * 1000;
            }

            if (candleTime > startTime + tolerance) return null;

            const historicPrice = parseFloat(kline[4]);
            const currentPrice = parseFloat(ticker.lastPrice);
            if (historicPrice === 0) return null;

            return {
                symbol: sym,
                change: parseFloat((((currentPrice - historicPrice) / historicPrice) * 100).toFixed(2))
            };
        }, (c, t) => UI.updateProgress(c, t));
    }

    renderAnalysisResults(mode, results, symbolsToAnalyze, timeLabel, hours) {
        if (mode === 'market') {
            const majorSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
            const majorMovers = majorSymbols.map(s => results.find(r => r.symbol === s)).filter(Boolean);

            const excludeInput = document.getElementById('exclude-input').value.toUpperCase().split(',').map(s => s.trim());
            const statsResults = results.filter(r => !excludeInput.includes(r.symbol.replace('USDT', '')));

            const allAnalyzedSymbols = results.map(r => r.symbol);
            const ignoredSymbols = symbolsToAnalyze.filter(s => !allAnalyzedSymbols.includes(s));

            const card = UI.renderCard('Full Market Analysis', `Timeframe: ${timeLabel}`, statsResults, ignoredSymbols, majorMovers, hours);
            UI.els.resultsArea.appendChild(card);
        } else {
            const longs = Object.keys(this.watchlists.long_watchlist || {});
            const shorts = Object.keys(this.watchlists.short_watchlist || {});

            const resLong = results.filter(r => longs.includes(r.symbol));
            const resShort = results.filter(r => shorts.includes(r.symbol));

            // Logic to calculate ignored could be extracted too, but this is fine for now
            const longAnalyzed = resLong.map(r => r.symbol);
            const shortAnalyzed = resShort.map(r => r.symbol);

            const longIgnored = longs.filter(s => !longAnalyzed.includes(s));
            const shortIgnored = shorts.filter(s => !shortAnalyzed.includes(s));

            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 xl:grid-cols-2 gap-8';
            grid.appendChild(UI.renderCard('Long Watchlist', `${resLong.length} Symbols`, resLong, longIgnored, null, hours));
            grid.appendChild(UI.renderCard('Short Watchlist', `${resShort.length} Symbols`, resShort, shortIgnored, null, hours));
            UI.els.resultsArea.appendChild(grid);
        }
    }

    saveFavorite() {
        if (!this.currentFile || !this.watchlists) return;
        const favs = this.getFavs();
        const clean = favs.filter(f => f.name !== this.currentFile);
        clean.push({ name: this.currentFile, data: this.watchlists });
        localStorage.setItem(Config.STORAGE_KEYS.FAVORITES, JSON.stringify(clean));
        this.updateActiveState(true);
    }

    getFavs() { try { return JSON.parse(localStorage.getItem(Config.STORAGE_KEYS.FAVORITES) || '[]'); } catch { return []; } }

    renderFavorites() {
        const list = UI.els.favList;
        list.innerHTML = '';
        const favs = this.getFavs();

        if (favs.length === 0) {
            list.innerHTML = '<div class="text-center py-4 bg-gray-800/30 rounded-lg border border-gray-800 border-dashed"><p class="text-gray-600 text-xs">No saved lists yet</p></div>';
            return;
        }

        favs.forEach(fav => {
            const isActive = fav.name === this.currentFile;
            const el = document.createElement('div');
            let classes = 'group flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all duration-200 ';

            if (isActive) {
                classes += 'bg-blue-900/10 border-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.1)]';
            } else {
                classes += 'bg-gray-800 border-gray-700 hover:border-gray-500 hover:bg-gray-750';
            }

            el.className = classes;
            const iconColor = isActive ? 'text-blue-400' : 'text-gray-500 group-hover:text-gray-300';

            el.innerHTML = `
                <div class="flex items-center gap-3 min-w-0">
                    <div class="${iconColor} transition-colors">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
                    </div>
                    <div class="min-w-0">
                        <p class="text-sm font-medium truncate ${isActive ? 'text-blue-100' : 'text-gray-300 group-hover:text-white'}">${fav.name}</p>
                    </div>
                </div>
                <button class="del-btn p-1.5 text-gray-600 hover:text-red-400 hover:bg-gray-700 rounded-md transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100" title="Delete">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            `;

            el.querySelector('.del-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeFav(fav.name);
            });

            el.addEventListener('click', () => {
                this.watchlists = fav.data;
                this.currentFile = fav.name;
                this.updateActiveState(true);
            });

            list.appendChild(el);
        });
    }

    removeFav(name) {
        const favs = this.getFavs().filter(f => f.name !== name);
        localStorage.setItem(Config.STORAGE_KEYS.FAVORITES, JSON.stringify(favs));
        this.updateActiveState(!!this.watchlists);
    }
}

console.log(`🚀 Bybit Analyzer v${Config.VERSION} initialized`);
new Analyzer();
