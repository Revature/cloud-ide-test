import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
    TestAdapter,
    TestResult,
    DiscoveredTest,
    JavaTestAdapter,
    AngularTestAdapter,
    PythonTestAdapter
} from './adapters';
import { TelemetryService } from './telemetry/telemetryService';
import { getConfig } from './config';
import { getApiClient, getApiClientType } from './api/apiClientFactory';
import { TestExecutionData } from './api/lmsClient.interface';
import { commitAndPushTestResults, isGitRepository } from './git/gitService';

const execAsync = promisify(exec);

interface TestState {
    name: string;
    filePath: string;
    state: 'not-run' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';
    message?: string;
    duration?: number;
    expected?: string;
    actual?: string;
    errorType?: string;
    fullOutput?: string; // Full stack trace or detailed output
}

export class TestViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _detailPanel?: vscode.WebviewPanel; // Separate detail panel
    private workspaceType: string;
    private testAdapter: TestAdapter;
    private configWarnings: string[];
    private workspaceTypeDisplay: string;
    private readOnlyTestFiles: Set<string> = new Set();
    private originalTestContent: Map<string, string> = new Map();
    
    // Persistent test state - survives webview disposal
    private discoveredTests: DiscoveredTest[] = [];
    private testStates: Map<string, TestState> = new Map(); // Key: `${filePath}::${testName}`
    private lastTestCommand: string = ''; // Store the command used to run tests
    
    // Helper to create unique test key
    private getTestKey(testName: string, filePath: string): string {
        return `${filePath}::${testName}`;
    }

    constructor(
        private readonly _extensionUri: vscode.Uri, 
        configWarnings: string[] = [],
        context?: vscode.ExtensionContext
    ) {
        // Get configuration (already validated at extension startup)
        const config = getConfig();
        this.workspaceType = config.workspaceType;
        this.workspaceTypeDisplay = config.workspaceType;
        this.configWarnings = configWarnings;
        
        // Initialize the appropriate test adapter
        this.testAdapter = this.getTestAdapter(config.workspaceType);
        
        // Setup read-only protection for test files
        if (context) {
            this.setupReadOnlyProtection(context);
        }
    }

    /**
     * Ensure the webview is visible (open it if closed)
     */
    public async ensureWebviewVisible(): Promise<void> {
        // Always try to focus the view to ensure it's visible
        await vscode.commands.executeCommand('cloudIdeTestView.focus');
        
        // If view wasn't initialized, wait for it
        if (!this._view) {
            // Wait up to 2 seconds for view to initialize
            for (let i = 0; i < 20; i++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (this._view) {
                    break;
                }
            }
        }
    }

    /**
     * Wait for the webview to be ready and have processed the testsDiscovered message
     */
    private webviewReady: boolean = false;
    
    private async waitForWebviewReady(): Promise<void> {
        if (this.webviewReady) {
            return;
        }
        
        // Wait up to 1 second for webview to signal it's ready
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (this.webviewReady) {
                return;
            }
        }
        
        // If still not ready, proceed anyway (webview might already be initialized)
        console.warn('Webview ready signal not received, proceeding anyway');
    }

    /**
     * Discover tests during extension activation (before webview is created)
     */
    public async discoverTestsOnActivation() {
        const testDirectory = this.getTestDirectory();
        if (!testDirectory) {
            console.log('No test directory found for test discovery');
            return;
        }

        console.log(`[Test Discovery] Using workspace directory: ${testDirectory}`);

        try {
            this.discoveredTests = await this.testAdapter.discoverTests(testDirectory);
            console.log(`[Test Discovery] Discovered ${this.discoveredTests.length} tests at extension activation`);
            
            // Initialize test states
            this.testStates.clear();
            this.discoveredTests.forEach(test => {
                console.log(`[Test Discovery] Test: ${test.name}, File: ${test.filePath}`);
                const key = this.getTestKey(test.name, test.filePath);
                console.log(`[Test Discovery] Generated key: ${key}`);
                this.testStates.set(key, {
                    name: test.name,
                    filePath: test.filePath,
                    state: 'not-run'
                });
            });
            console.log(`[Test Discovery] Total unique tests in Map: ${this.testStates.size}`);

            // Dump discovered tests to file for debugging
            const now = new Date();
            const folderTimestamp = now.toISOString().slice(0, 16).replace(/[:.]/g, '-'); // Up to minute: 2026-01-14T19-43
            const dumpDir = path.join('/tst', folderTimestamp);
            if (!fs.existsSync(dumpDir)) {
                fs.mkdirSync(dumpDir, { recursive: true });
            }
            const dumpPath = path.join(dumpDir, 'discovered-tests.json');
            const dumpData = {
                timestamp: now.toISOString(),
                testCount: this.discoveredTests.length,
                tests: this.discoveredTests.map(t => ({
                    name: t.name,
                    filePath: t.filePath,
                    key: this.getTestKey(t.name, t.filePath)
                }))
            };
            fs.writeFileSync(dumpPath, JSON.stringify(dumpData, null, 2));
            console.log(`[Test Discovery] Dumped discovered tests to: ${dumpPath}`);

            // Make test files read-only
            await this.makeTestFilesReadOnly(this.discoveredTests.map(t => t.filePath));
        } catch (error) {
            console.error('Failed to discover tests on activation:', error);
        }
    }

    private getTestAdapter(workspaceType: 'Java' | 'Angular' | 'Python'): TestAdapter {
        switch (workspaceType) {
            case 'Java':
                return new JavaTestAdapter();
            case 'Angular':
                return new AngularTestAdapter();
            case 'Python':
                return new PythonTestAdapter();
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send configuration warnings to webview if any
        if (this.configWarnings.length > 0) {
            // Use setTimeout to ensure the webview is fully loaded
            setTimeout(() => {
                webviewView.webview.postMessage({
                    type: 'configWarning',
                    warning: this.configWarnings.join('\n')
                });
            }, 100);
        }

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'webviewReady':
                    // Webview is ready, send tests immediately
                    console.log('[TestViewProvider] Webview ready, sending tests');
                    this.webviewReady = true; // Signal that webview has loaded
                    this.discoverAndDisplayTests();
                    break;
                case 'runTests':
                    await this.runTests();
                    break;
                case 'testClicked':
                    // Open detail panel with test details
                    const key = this.getTestKey(data.testName, data.filePath);
                    const testState = this.testStates.get(key);
                    if (testState && testState.state !== 'not-run') {
                        this.showTestDetailPanel(testState);
                    }
                    break;
            }
        });
    }

    private async discoverAndDisplayTests() {
        if (!this._view) {
            console.log('[discoverAndDisplayTests] No webview available');
            return;
        }

        // Send cached test states to the webview (no need to re-discover)
        const tests = Array.from(this.testStates.values());
        console.log(`[discoverAndDisplayTests] Sending ${tests.length} tests to webview`);
        console.log('[discoverAndDisplayTests] Test states:', tests);
        
        this._view.webview.postMessage({
            type: 'testsDiscovered',
            tests: tests
        });
    }

    private async makeTestFilesReadOnly(testFilePaths: string[]): Promise<void> {
        const workspaceRoot = this.getTestDirectory();
        if (!workspaceRoot) {
            console.warn('Cannot make test files read-only: No workspace root found');
            return;
        }

        console.log(`[chmod] Workspace root: ${workspaceRoot}`);
        
        for (const filePath of testFilePaths) {
            // Convert to absolute path - resolve relative to workspace root
            const absolutePath = path.isAbsolute(filePath) 
                ? filePath 
                : path.join(workspaceRoot, filePath);
            
            console.log(`[chmod] Processing file: ${filePath} -> ${absolutePath}`);
            
            // Track this as a read-only file (using absolute path)
            this.readOnlyTestFiles.add(absolutePath);
            
            // Store original content
            try {
                const content = fs.readFileSync(absolutePath, 'utf8');
                this.originalTestContent.set(absolutePath, content);
                console.log(`Stored original content for: ${absolutePath}`);
            } catch (error) {
                console.warn(`Failed to read test file content: ${absolutePath}`, error);
            }
            
            try {
                // Set read-only at OS level (Linux/Mac) - use absolute path
                const chmodResult = await execAsync(`sudo chmod 444 "${absolutePath}"`);
                console.log(`chmod output: ${chmodResult.stdout || '(no output)'}`);
                
                // Verify the permissions were set
                const lsResult = await execAsync(`ls -l "${absolutePath}"`);
                console.log(`File permissions after chmod: ${lsResult.stdout}`);
                
                if (!lsResult.stdout.includes('r--r--r--')) {
                    console.error(`WARNING: File permissions not set correctly for ${absolutePath}`);
                    vscode.window.showWarningMessage(
                        `Failed to set test file as read-only: ${path.basename(absolutePath)}`
                    );
                } else {
                    console.log(`✓ Successfully set read-only permissions for: ${path.basename(absolutePath)}`);
                }
        } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.error(`Failed to chmod test file: ${absolutePath}`, errorMsg);
                vscode.window.showWarningMessage(
                    `Failed to protect test file: ${path.basename(absolutePath)} - ${errorMsg}`
                );
            }
        }
    }

    private setupReadOnlyProtection(context: vscode.ExtensionContext): void {
        // Intercept text edits and reject them
        const editDisposable = vscode.workspace.onWillSaveTextDocument((event) => {
            const filePath = event.document.uri.fsPath;
            if (this.readOnlyTestFiles.has(filePath)) {
                vscode.window.showErrorMessage(
                    `Cannot save test file "${path.basename(filePath)}" - it is read-only.`
                );
                // Cancel the save operation
                event.waitUntil(Promise.resolve(false as any));
            }
        });

        // Track when a readonly file is opened and immediately close the editor, reopen as preview
        const openDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
            const filePath = document.uri.fsPath;
            if (this.readOnlyTestFiles.has(filePath)) {
                // Get all visible editors
                const editors = vscode.window.visibleTextEditors;
                for (const editor of editors) {
                    if (editor.document.uri.fsPath === filePath) {
                        // Mark editor viewColumn for reopening
                        const viewColumn = editor.viewColumn;
                        
                        // Close the editable version
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        
                        // Reopen in preview mode (readonly)
                        await vscode.commands.executeCommand('vscode.open', document.uri, {
                            preview: true,
                            viewColumn: viewColumn
                        });
                        
                        vscode.window.showWarningMessage(
                            `Test file "${path.basename(filePath)}" opened in read-only mode.`
                        );
                        break;
                    }
                }
            }
        });
        
        context.subscriptions.push(editDisposable, openDisposable);
    }

    private getTestDirectory(): string | null {
        // Always use the first workspace folder as the test directory
        // This ensures we get the user's actual workspace, not any internal IDE files
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            return vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

        return null;
    }

    public async runTests() {
        if (!this._view) {
            vscode.window.showErrorMessage('Test view not initialized');
            return;
        }

        const testDirectory = this.getTestDirectory();
        if (!testDirectory) {
            this._view.webview.postMessage({
                type: 'testError',
                error: 'No workspace folder found. Please open a folder or workspace to run tests.'
            });
            return;
        }

        // Wait for webview to be ready and have test states populated
        // This is especially important when invoked externally
        await this.waitForWebviewReady();

        // Update UI to show loading state
        this._view.webview.postMessage({
            type: 'testRunning',
            workspaceType: this.workspaceType
        });

        const telemetry = TelemetryService.getInstance();
        const operationId = telemetry.createOperationId();
        telemetry.sendOperationStart(operationId, 'test.execution');
        const startTime = Date.now();
        
        try {
            // Run tests using the appropriate test adapter with 10 minute timeout
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Test execution timed out after 10 minutes')), 600000);
            });
            
            const results = await Promise.race([
                this.testAdapter.runTests(testDirectory),
                timeoutPromise
            ]);
            const duration = Date.now() - startTime;

            // Send telemetry with complete test data - exact Revature pattern
            telemetry.trackTestExecution(
                operationId,
                this.workspaceType,
                results.totalTests,
                results.passedTests,
                results.failedTests,
                results.skippedTests,
                duration
            );

            // Track individual failed tests with expected/actual details
            for (const test of results.tests) {
                if (test.status === 'failed') {
                    telemetry.trackTestFailure(
                        this.workspaceType,
                        test.name,
                        test.message,
                        test.expected,
                        test.actual
                    );
                }
            }

            telemetry.sendOperationEnd(operationId, 'test.execution', duration);

            // Send test results to LMS API
            const apiClient = getApiClient();
            const apiClientType = getApiClientType();
            const testMessage = `Tests run: ${results.totalTests}, Passed: ${results.passedTests}, Failed: ${results.failedTests}, Errored: 0, Skipped: ${results.skippedTests}`;
            
            const testData: TestExecutionData = {
                totalTests: results.totalTests,
                passedTests: results.passedTests,
                failedTests: results.failedTests,
                erroredTests: 0, // We don't track this separately yet
                skippedTests: results.skippedTests,
                testCaseMessage: testMessage
            };
            
            // Different flow for Revature vs Evolv
            // Revature: Handles commit, API calls, and push internally
            // Evolv: API call only, git operations handled separately
            if (apiClientType === 'revature') {
                // Revature API client handles: commit → capture metadata → API calls → push
                // All operations are done internally, only need to call sendTestResults
                console.log('[TestViewProvider] Using Revature API flow (commit → API → push)');
                apiClient.sendTestResults(testDirectory, testData).catch(error => {
                    console.error('[TestViewProvider] Failed to send test results (Revature):', error);
                    vscode.window.showErrorMessage(`Failed to send test results: ${error.message}`);
                });
            } else {
                // Evolv API flow: Send API call, then handle git separately
                console.log('[TestViewProvider] Using Evolv API flow (API + separate git)');
                
                // Send to Evolv API (don't block on this)
                apiClient.sendTestResults(testDirectory, testData).catch(error => {
                    console.error('[TestViewProvider] Failed to send test results (Evolv):', error);
                });
                
                // Handle git commit/push separately for Evolv
                isGitRepository(testDirectory).then(isGit => {
                    if (isGit) {
                        commitAndPushTestResults(
                            testDirectory,
                            results.totalTests,
                            results.passedTests,
                            results.failedTests,
                            results.skippedTests
                        ).catch(error => {
                            console.error('[TestViewProvider] Git commit/push failed:', error);
                        });
                    } else {
                        // Show warning if not a git repository
                        vscode.window.showWarningMessage(
                            'Cloud IDE Test: Workspace is not a git repository. Test results will not be committed.'
                        );
                    }
                }).catch(error => {
                    console.error('[TestViewProvider] Failed to check git status:', error);
                });
            }

            // Store the command used for this test run
            if (results.command) {
                this.lastTestCommand = results.command;
            }

            // Update cached test states with results
            // Match test results back to discovered tests by name to get file path
            results.tests.forEach(test => {
                // Find ALL discovered tests with this name (handles duplicate names in different files)
                const matchingTests = this.discoveredTests.filter(dt => dt.name === test.name);
                
                if (matchingTests.length > 0) {
                    // Update all tests with this name (e.g., "should create the component" in multiple files)
                    matchingTests.forEach(discoveredTest => {
                        const key = this.getTestKey(test.name, discoveredTest.filePath);
                        const existingState = this.testStates.get(key);
                        if (existingState) {
                            existingState.state = test.status;
                            existingState.message = test.message;
                            existingState.duration = test.duration;
                            existingState.expected = test.expected;
                            existingState.actual = test.actual;
                            existingState.fullOutput = test.fullOutput;
                        }
                    });
                }
            });

            // Send results back to the webview
            this._view.webview.postMessage({
                type: 'testResults',
                results: results,
                workspaceType: this.workspaceType,
                command: this.lastTestCommand
            });
        } catch (error) {
            const duration = Date.now() - startTime;
            
            // Track error - exact Revature pattern
            const err = error instanceof Error ? error : new Error(String(error));
            telemetry.sendOperationError(operationId, 'test.execution', err);
            telemetry.sendOperationEnd(operationId, 'test.execution', duration);

            vscode.window.showErrorMessage(`Test execution failed: ${error}`);
            this._view.webview.postMessage({
                type: 'testError',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // Load the HTML, CSS, and JS from separate files
        const webviewPath = path.join(__dirname, 'webview');
        
        const htmlTemplate = fs.readFileSync(path.join(webviewPath, 'testView.html'), 'utf8');
        const sharedCss = fs.readFileSync(path.join(webviewPath, 'shared.css'), 'utf8');
        const cssContent = fs.readFileSync(path.join(webviewPath, 'testView.css'), 'utf8');
        const jsContent = fs.readFileSync(path.join(webviewPath, 'testView.js'), 'utf8');
        
        // Replace placeholders in the HTML template
        const html = htmlTemplate
            .replace('__SHARED_STYLES__', sharedCss)
            .replace('__STYLES__', cssContent)
            .replace('__SCRIPT__', jsContent)
            .replace('__WORKSPACE_TYPE__', this.workspaceTypeDisplay);
        
        return html;
    }

    private showTestDetailPanel(test: TestState) {
        // If panel already exists, reveal it and update content
        if (this._detailPanel) {
            this._detailPanel.reveal(vscode.ViewColumn.Two);
            this._detailPanel.webview.postMessage({
                type: 'showTestDetails',
                test: test,
                command: this.lastTestCommand
            });
            return;
        }

        // Create new panel
        // Note: VSCode doesn't provide API to control webview size directly
        // The size is determined by the user's editor layout and column splits
        this._detailPanel = vscode.window.createWebviewPanel(
            'testDetails',
            'Test Details',
            {
                viewColumn: vscode.ViewColumn.Two,
                preserveFocus: false // Focus the detail panel when it opens
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Set HTML content
        this._detailPanel.webview.html = this._getDetailPanelHtml(this._detailPanel.webview);

        // Handle panel disposal
        this._detailPanel.onDidDispose(() => {
            this._detailPanel = undefined;
        });

        // Handle messages from detail panel
        this._detailPanel.webview.onDidReceiveMessage((data) => {
            switch (data.type) {
                case 'detailPanelReady':
                    // Send test details once panel is ready
                    if (this._detailPanel) {
                        this._detailPanel.webview.postMessage({
                            type: 'showTestDetails',
                            test: test,
                            command: this.lastTestCommand
                        });
                    }
                    break;
            }
        });
    }

    private _getDetailPanelHtml(webview: vscode.Webview): string {
        // Load the HTML, CSS, and JS from separate files
        const webviewPath = path.join(__dirname, 'webview');
        
        const htmlTemplate = fs.readFileSync(path.join(webviewPath, 'testDetail.html'), 'utf8');
        const sharedCss = fs.readFileSync(path.join(webviewPath, 'shared.css'), 'utf8');
        const cssContent = fs.readFileSync(path.join(webviewPath, 'testDetail.css'), 'utf8');
        const jsContent = fs.readFileSync(path.join(webviewPath, 'testDetail.js'), 'utf8');
        
        // Replace placeholders in the HTML template
        const html = htmlTemplate
            .replace('__SHARED_STYLES__', sharedCss)
            .replace('__STYLES__', cssContent)
            .replace('__SCRIPT__', jsContent);
        
        return html;
    }
}

