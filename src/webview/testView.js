const vscode = acquireVsCodeApi();

// Enable right-click context menu for copying text
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('contextmenu', (e) => {
        // Allow default context menu on text elements
        e.stopPropagation();
    });
});

// Helper function to create unique test key
function getTestKey(testName, filePath) {
    return `${filePath}::${testName}`;
}

// Store test states
let testStates = new Map(); // testKey (filePath::testName) -> { name, filePath, state, message, duration, expected, actual, errorType }
let previousTestStates = new Map(); // Store previous run results to detect changes
let scrollAnchor = null; // { testKey: string, viewportOffset: number } - captured before running
let previousStats = { passed: 0, failed: 0 }; // Track previous stats for flash animations (failed includes errors)

function runTests() {
    vscode.postMessage({ type: 'runTests' });
}

function showStatus(message, type) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
    statusEl.style.display = 'block';
}

function hideStatus() {
    document.getElementById('status').style.display = 'none';
}

function renderTests(options = {}) {
    const resultsEl = document.getElementById('results');
    
    if (testStates.size === 0) {
        resultsEl.innerHTML = '<div class="no-results">No tests discovered</div>';
        return;
    }
    
    // Store scroll position and find topmost visible test before re-rendering
    let topmostTestKey = null;
    let testViewportOffset = 0; // Position relative to viewport top (stays constant after render)
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    
    // Use saved scroll anchor if provided, otherwise capture current position
    if (options.useScrollAnchor && scrollAnchor) {
        topmostTestKey = scrollAnchor.testKey;
        testViewportOffset = scrollAnchor.viewportOffset;
    } else if (!options.skipScrollPreservation) {
        // Find which test is currently at the top of the viewport
        const testItems = resultsEl.querySelectorAll('.test-item');
        for (const item of testItems) {
            const rect = item.getBoundingClientRect();
            // Check if this test is visible in viewport (accounting for sticky header ~60px)
            if (rect.top >= 50 && rect.top <= window.innerHeight) {
                const nameEl = item.querySelector('.test-name');
                if (nameEl) {
                    // Extract test key from onclick attribute
                    const onclickAttr = item.getAttribute('onclick');
                    const match = /handleTestClick\('(.+?)'\)/.exec(onclickAttr);
                    if (match) {
                        topmostTestKey = match[1].replace(/\\'/g, "'");
                        // Store viewport position (distance from top of viewport)
                        testViewportOffset = rect.top;
                        break;
                    }
                }
            }
        }
        
        if (!topmostTestKey && testItems.length > 0) {
            // Fallback: use first test if nothing found
            const firstOnclick = testItems[0].getAttribute('onclick');
            const firstMatch = /handleTestClick\('(.+?)'\)/.exec(firstOnclick);
            if (firstMatch) {
                topmostTestKey = firstMatch[1].replace(/\\'/g, "'");
                const firstRect = testItems[0].getBoundingClientRect();
                testViewportOffset = firstRect.top;
            }
        }
    }
    
    // Calculate stats
    const total = testStates.size;
    const notRun = Array.from(testStates.values()).filter(t => t.state === 'not-run').length;
    const running = Array.from(testStates.values()).filter(t => t.state === 'running').length;
    const passed = Array.from(testStates.values()).filter(t => t.state === 'passed').length;
    const failed = Array.from(testStates.values()).filter(t => t.state === 'failed').length;
    const error = Array.from(testStates.values()).filter(t => t.state === 'error').length;
    const skipped = Array.from(testStates.values()).filter(t => t.state === 'skipped').length;
    
    // Combine errors and failures into a single "Failures" count
    const totalFailures = failed + error;
    
    // While tests are running, show previous stats to avoid jitter
    let displayPassed = passed;
    let displayFailed = totalFailures;
    
    if (running > 0 && !options.afterTestResults) {
        // Tests are running, show previous final stats
        displayPassed = previousStats.passed || 0;
        displayFailed = previousStats.failed || 0;
    }
    
    // Determine flash animations for stats (always flash when tests complete)
    let passedFlash = '';
    let failedFlash = '';
    
    if (options.afterTestResults) {
        // Always flash when tests complete, regardless of whether counts changed
        if (passed > 0) {
            passedFlash = 'stat-flash-green';
        }
        if (totalFailures > 0) {
            failedFlash = 'stat-flash-red';
        }
        
        // Update previous stats after displaying flash
        previousStats = { passed, failed: totalFailures };
    }
    
    let html = `
        <div class="test-summary">
            <div class="section-title">Test Summary</div>
            <div class="stats-grid">
                <div class="stat-item">
                    <span class="stat-value">${total}</span>
                    <span class="stat-label">Total</span>
                </div>
                <div class="stat-item ${passedFlash}">
                    <span class="stat-value" style="color: #73c991;">${displayPassed}</span>
                    <span class="stat-label">Passed</span>
                </div>
                <div class="stat-item ${failedFlash}">
                    <span class="stat-value" style="color: #d32f2f;">${displayFailed}</span>
                    <span class="stat-label">Failures</span>
                </div>
            </div>
        </div>
    `;
    
    // Group tests by file
    const testsByFile = new Map();
    testStates.forEach((test, testKey) => {
        if (!testsByFile.has(test.filePath)) {
            testsByFile.set(test.filePath, []);
        }
        testsByFile.get(test.filePath).push({ test, testKey });
    });
    
    // Render each file group
    testsByFile.forEach((tests, filePath) => {
        // Calculate file-level stats
        const fileTotal = tests.length;
        const filePassed = tests.filter(t => t.test.state === 'passed').length;
        const fileFailed = tests.filter(t => t.test.state === 'failed' || t.test.state === 'error').length;
        
        html += `
            <div class="file-group">
                <div class="file-header">
                    <div class="file-path">${escapeHtml(filePath)}</div>
                    <div class="file-stats">
                        <span class="file-stat-passed">${filePassed}/${fileTotal}</span>
                        ${fileFailed > 0 ? `<span class="file-stat-failed">${fileFailed} failed</span>` : ''}
                    </div>
                </div>
        `;
        
        tests.forEach(({ test, testKey }) => {
            const stateClass = test.state || 'not-run';
            let displayState = test.state || 'not run';
            
            // Check if status changed from previous run
            let flashClass = '';
            const previousTest = previousTestStates.get(testKey);
            if (previousTest && previousTest.state !== test.state) {
                // Status changed
                if ((previousTest.state === 'failed' || previousTest.state === 'not-run') && test.state === 'passed') {
                    flashClass = 'status-improved';
                } else if ((previousTest.state === 'passed' || previousTest.state === 'not-run') && test.state === 'failed') {
                    flashClass = 'status-regressed';
                }
            }
            
            html += `
                <div class="test-item test-${stateClass} ${flashClass}" onclick="handleTestClick('${escapeHtml(testKey).replace(/'/g, "\\'")}')">
                    <div class="test-name">${formatTestName(test.name)}</div>
                    <div class="test-status">${displayState}</div>
                    ${test.duration ? `<div class="test-duration">Duration: ${test.duration}ms</div>` : ''}
                    ${test.message ? `<div class="test-details">
                        <span class="label">Message</span>
                        <div class="value">${escapeHtml(test.message)}</div>
                    </div>` : ''}
                    ${test.expected ? `<div class="test-details">
                        <span class="label">Expected</span>
                        <div class="value">${escapeHtml(test.expected)}</div>
                        <span class="label">Actual</span>
                        <div class="value">${escapeHtml(test.actual || 'N/A')}</div>
                    </div>` : ''}
                </div>
            `;
        });
        
        html += `</div>`; // Close file-group
    });
    
    resultsEl.innerHTML = html;
    
    // Restore scroll position to maintain same viewport offset for target test
    if (topmostTestKey && !options.skipScrollPreservation) {
        // Use single requestAnimationFrame for faster restoration
        requestAnimationFrame(() => {
            const testItems = resultsEl.querySelectorAll('.test-item');
            
            for (const item of testItems) {
                // Extract test key from onclick attribute
                const onclickAttr = item.getAttribute('onclick');
                const match = /handleTestClick\('(.+?)'\)/.exec(onclickAttr);
                if (match) {
                    const itemTestKey = match[1].replace(/\\'/g, "'");
                    if (itemTestKey === topmostTestKey) {
                        // Find where the test is now in the viewport
                        const rect = item.getBoundingClientRect();
                        const currentScrollTop = window.scrollY || document.documentElement.scrollTop;
                        
                        // Calculate scroll needed to put test at same viewport offset
                        const scrollDelta = rect.top - testViewportOffset;
                        const targetScrollTop = currentScrollTop + scrollDelta;
                        
                        window.scrollTo({
                            top: targetScrollTop,
                            behavior: 'instant'
                        });
                        break;
                    }
                }
            }
        });
    }
}

function renderResults(results, workspaceType) {
    // Track which tests have been updated (for sequential matching of duplicates)
    const testUpdateIndex = new Map(); // testName -> next index to update
    
    // Update test states based on results
    results.tests.forEach(test => {
        let matchedKey = null;
        
        // Try to find exact match by filePath + name if filePath is available
        if (test.filePath) {
            const exactKey = getTestKey(test.name, test.filePath);
            if (testStates.has(exactKey)) {
                matchedKey = exactKey;
                console.log(`[Webview] Exact match found for ${test.name} at ${test.filePath}`);
            }
        }
        
        // If no exact match, find by name only
        if (!matchedKey) {
            const matchedKeys = [];
            testStates.forEach((value, key) => {
                if (value.name === test.name) {
                    matchedKeys.push(key);
                }
            });
            
            if (matchedKeys.length === 1) {
                // Single match - update it directly
                matchedKey = matchedKeys[0];
            } else if (matchedKeys.length > 1) {
                // Multiple matches (duplicates) - use sequential matching
                // First result updates first test, second result updates second test, etc.
                const currentIndex = testUpdateIndex.get(test.name) || 0;
                if (currentIndex < matchedKeys.length) {
                    matchedKey = matchedKeys[currentIndex];
                    testUpdateIndex.set(test.name, currentIndex + 1);
                    console.log(`[Webview] Sequential match #${currentIndex + 1} for duplicate test: ${test.name}`);
                }
            }
        }
        
        // Update the matched test
        if (matchedKey) {
            const state = testStates.get(matchedKey);
            state.state = test.status;
            state.duration = test.duration;
            state.message = test.message;
            state.expected = test.expected;
            state.actual = test.actual;
            state.errorType = test.errorType;
            testStates.set(matchedKey, state);
        } else {
            // Add it anyway with a generated key (shouldn't happen but fallback)
            const testKey = getTestKey(test.name, test.filePath || 'unknown');
            testStates.set(testKey, {
                name: test.name,
                state: test.status,
                filePath: test.filePath || 'unknown',
                duration: test.duration,
                message: test.message,
                expected: test.expected,
                actual: test.actual,
                errorType: test.errorType
            });
        }
    });
    
    // Render with saved scroll anchor to avoid jumps, and trigger stat flashes
    renderTests({ useScrollAnchor: true, afterTestResults: true });
    
    // Clear scroll anchor after use
    scrollAnchor = null;
    
    // Store current states as previous states for next run
    previousTestStates = new Map();
    testStates.forEach((value, key) => {
        previousTestStates.set(key, { state: value.state });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTestName(name) {
    // Escape HTML first
    const escaped = escapeHtml(name);
    // Insert zero-width space after periods to allow breaking
    // This allows the browser to break at periods when needed
    return escaped.replace(/\./g, '.<wbr>');
}

// Handle messages from the extension
window.addEventListener('message', event => {
    const message = event.data;
    const button = document.getElementById('runTestsBtn');
    
    switch (message.type) {
        case 'testsDiscovered':
            console.log('[Webview] Received testsDiscovered message with', message.tests.length, 'tests');
            console.log('[Webview] Tests:', message.tests);
            
            // Initialize test states with discovered tests (including all result data)
            testStates.clear();
            message.tests.forEach(test => {
                const testKey = getTestKey(test.name, test.filePath);
                testStates.set(testKey, {
                    name: test.name,
                    state: test.state,
                    filePath: test.filePath,
                    message: test.message,
                    duration: test.duration,
                    expected: test.expected,
                    actual: test.actual
                });
            });
            
            console.log('[Webview] testStates after population:', testStates.size, 'entries');
            renderTests();
            
            // Save initial "not-run" state so first test run can flash
            previousTestStates = new Map();
            testStates.forEach((value, key) => {
                previousTestStates.set(key, { state: value.state });
            });
            
            // Initialize previous stats (all zeros since all tests are not-run)
            previousStats = { passed: 0, failed: 0, error: 0 };
            
            // Save state
            vscode.setState({
                testStates: Array.from(testStates.entries()),
                previousTestStates: Array.from(previousTestStates.entries()),
                previousStats: previousStats
            });
            break;
            
        case 'configWarning':
            showStatus('⚠️ ' + message.warning, 'warning');
            // Save state
            vscode.setState({
                ...vscode.getState(),
                status: { message: '⚠️ ' + message.warning, type: 'warning' }
            });
            break;
            
        case 'configError':
            button.disabled = true;
            const resultsEl = document.getElementById('results');
            resultsEl.innerHTML = `<div class="no-results">${escapeHtml(message.error)}</div>`;
            // Save state
            vscode.setState({
                status: { message: 'Configuration error', type: 'error' },
                error: message.error
            });
            break;
            
        case 'testRunning':
            button.disabled = true;
            hideStatus(); // Don't show status message while running
            
            // Capture scroll position BEFORE changing to running state
            const scrollTop = window.scrollY || document.documentElement.scrollTop;
            if (scrollTop > 0) {
                const resultsEl = document.getElementById('results');
                const testItems = resultsEl.querySelectorAll('.test-item');
                for (const item of testItems) {
                    const rect = item.getBoundingClientRect();
                    if (rect.top >= 50 && rect.top <= window.innerHeight) {
                        // Extract test key from onclick attribute
                        const onclickAttr = item.getAttribute('onclick');
                        const match = /handleTestClick\('(.+?)'\)/.exec(onclickAttr);
                        if (match) {
                            scrollAnchor = {
                                testKey: match[1].replace(/\\'/g, "'"),
                                viewportOffset: rect.top
                            };
                            break;
                        }
                    }
                }
            }
            
            // Set all tests to running state
            testStates.forEach((test, testKey) => {
                test.state = 'running';
            });
            renderTests({ useScrollAnchor: true }); // Use captured anchor to avoid shift
            break;
            
        case 'testResults':
            button.disabled = false;
            hideStatus();
            renderResults(message.results, message.workspaceType);
            
            // Save state for persistence
            vscode.setState({
                testStates: Array.from(testStates.entries()),
                previousTestStates: Array.from(previousTestStates.entries()),
                previousStats: previousStats,
                workspaceType: message.workspaceType
            });
            break;
            
        case 'testError':
            button.disabled = false;
            const errorMessage = 'Error: ' + message.error;
            showStatus(errorMessage, 'error');
            // Save state
            vscode.setState({
                ...vscode.getState(),
                status: { message: errorMessage, type: 'error' }
            });
            break;
    }
});

// Restore previous state when webview is reopened
window.addEventListener('DOMContentLoaded', () => {
    // Don't restore test states - always start fresh when webview opens
    // The testsDiscovered message will be sent shortly after webview opens
    
    const previousState = vscode.getState();
    if (previousState) {
        // Only restore persistent error state if it exists
        if (previousState.error) {
            const button = document.getElementById('runTestsBtn');
            button.disabled = true;
            const resultsEl = document.getElementById('results');
            resultsEl.innerHTML = `<div class="no-results">${escapeHtml(previousState.error)}</div>`;
        }
        // Only restore warning/error status messages (not test completion messages)
        if (previousState.status && (previousState.status.type === 'warning' || previousState.status.type === 'error')) {
            showStatus(previousState.status.message, previousState.status.type);
        }
    }
    
    // Show "Discovering tests..." message until testsDiscovered arrives
    const resultsEl = document.getElementById('results');
    resultsEl.innerHTML = '<div class="no-results">Discovering tests...</div>';
    
    // Notify extension that webview is ready to receive messages
    console.log('[Webview] Sending webviewReady message');
    vscode.postMessage({ type: 'webviewReady' });
});

// Test click handler
function handleTestClick(testKey) {
    const testData = testStates.get(testKey);
    if (!testData || testData.state === 'not-run') {
        return; // Don't show detail for not-run tests
    }
    
    // Request to open detail panel with test details
    vscode.postMessage({ 
        type: 'testClicked',
        testName: testData.name,
        filePath: testData.filePath || ''
    });
}