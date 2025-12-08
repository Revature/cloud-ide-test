import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { TestAdapter, TestResult, TestCase, DiscoveredTest } from './testAdapter';
import { decodeXmlEntities } from './shared/xmlUtils';
import { cleanAnsiEscapeCodes, generateFullOutput } from './shared/outputUtils';

const execAsync = promisify(exec);

export class JavaTestAdapter implements TestAdapter {
    private discoveredTests: DiscoveredTest[] = [];

    async discoverTests(directory: string): Promise<DiscoveredTest[]> {
        const tests: DiscoveredTest[] = [];
        const testDir = path.join(directory, 'src', 'test', 'java');

        if (!fs.existsSync(testDir)) {
            return tests;
        }

        // Recursively find all test files
        const findTestFiles = (dir: string): string[] => {
            const files: string[] = [];
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    files.push(...findTestFiles(fullPath));
                } else if (entry.isFile() && entry.name.endsWith('.java')) {
                    // Match common test file naming conventions:
                    // - *Test.java (e.g., UserTest.java)
                    // - *Tests.java (e.g., UserTests.java)
                    // - Test*.java (e.g., TestUser.java)
                    // - *TestCase.java (e.g., UserTestCase.java)
                    // - *IT.java (integration tests, e.g., UserIT.java)
                    const baseName = entry.name.replace('.java', '');
                    if (baseName.endsWith('Test') || 
                        baseName.endsWith('Tests') || 
                        baseName.startsWith('Test') ||
                        baseName.endsWith('TestCase') ||
                        baseName.endsWith('IT')) {
                        files.push(fullPath);
                    }
                }
            }
            return files;
        };

        const testFiles = findTestFiles(testDir);

        // Parse each test file to discover test methods
        for (const filePath of testFiles) {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            
            let packageName = '';
            let currentClass = '';
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                // Find package declaration
                const packageMatch = /package\s+([\w.]+);/.exec(line);
                if (packageMatch) {
                    packageName = packageMatch[1];
                }
                
                // Find test classes (support both public and package-private classes)
                // JUnit 5 allows package-private test classes
                // Only match top-level class declarations (line starts with optional modifiers then "class")
                // This avoids matching comments like "// This class..." or inner classes
                const trimmedLine = line.trim();
                const classMatch = /^(?:public\s+|final\s+|abstract\s+)*class\s+(\w+)/.exec(trimmedLine);
                if (classMatch) {
                    currentClass = classMatch[1];
                }
                
                // Find test methods - marked with test annotations
                // Support JUnit 4 (@Test) and JUnit 5 (@Test, @ParameterizedTest, @RepeatedTest, @TestFactory)
                const testAnnotations = ['@Test', '@ParameterizedTest', '@RepeatedTest', '@TestFactory'];
                const hasTestAnnotation = testAnnotations.some(ann => line.trim().startsWith(ann));
                
                if (hasTestAnnotation) {
                    // Look ahead for method signature - may have multiple annotations or blank lines
                    // Search up to 10 lines ahead to find the method
                    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
                        const nextLine = lines[j].trim();
                        if (nextLine === '') continue; // Skip empty lines
                        
                        // Skip other annotations (they start with @)
                        if (nextLine.startsWith('@')) continue;
                        
                        // Match method signatures:
                        // - "public void methodName(" - JUnit 4 style
                        // - "void methodName(" - JUnit 5 package-private
                        // - "public void methodName (" - with space before paren
                        // - "protected void methodName(" - less common but valid
                        const methodMatch = /(?:public\s+|protected\s+|private\s+)?void\s+(\w+)\s*\(/.exec(nextLine);
                        if (methodMatch && currentClass) {
                            // Use fully qualified class name to match Maven XML reports
                            const fullClassName = packageName ? `${packageName}.${currentClass}` : currentClass;
                            const testName = `${fullClassName}.${methodMatch[1]}`;
                            tests.push({
                                name: testName,
                                filePath: path.relative(directory, filePath)
                            });
                        }
                        break; // Found a non-annotation, non-empty line - stop looking
                    }
                }
            }
        }

        // Store discovered tests for validation during test execution
        this.discoveredTests = tests;
        return tests;
    }

    async runTests(directory: string): Promise<TestResult> {
        // Check if pom.xml exists (Maven project)
        const pomPath = path.join(directory, 'pom.xml');
        const hasPom = fs.existsSync(pomPath);

        if (!hasPom) {
            throw new Error('No pom.xml found. This doesn\'t appear to be a Maven project.');
        }

        let stdout = '';
        let stderr = '';
        
        try {
            // Run Maven tests
            const command = 'mvn test';
            const result = await execAsync(command, {
                cwd: directory,
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer
            });
            stdout = result.stdout;
            stderr = result.stderr;
        } catch (error: any) {
            // Command failed (non-zero exit code) - this is NORMAL when tests fail
            stdout = error.stdout || '';
            stderr = error.stderr || '';
            
            if (!stdout && !stderr) {
                console.error('[Java Adapter] Maven command failed with no output:');
                console.error('Error:', error.message);
                console.error('Command:', 'mvn test');
                console.error('Working directory:', directory);
                throw new Error(`Failed to run Maven tests: ${error.message}`);
            }
        }

        // Always parse the output, whether tests passed or failed
        const result = this.parseTestOutput(stdout, stderr, directory);
        
        // Generate full output for display (cleans ANSI codes automatically)
        const fullOutput = generateFullOutput(stdout, stderr);
        result.tests = result.tests.map(test => ({
            ...test,
            fullOutput: test.fullOutput ? cleanAnsiEscapeCodes(test.fullOutput) : fullOutput
        }));
        
        // Add the command to the result
        result.command = 'mvn test';
        
        // Validate: if we discovered tests but got no results, show them as errors
        if (this.discoveredTests.length > 0 && result.tests.length === 0) {
            const errorMessage = `Test execution failed: Discovered ${this.discoveredTests.length} tests but got no results. ` +
                `This may indicate a Maven configuration issue or missing dependencies.`;
            
            console.error('[Java Adapter] Test execution error - Full output:');
            console.error('=== STDOUT ===');
            console.error(stdout || '(empty)');
            console.error('=== STDERR ===');
            console.error(stderr || '(empty)');
            console.error('=== END OUTPUT ===');
            
            // Return discovered tests with error status instead of throwing
            return {
                tests: this.discoveredTests.map(test => ({
                    name: test.name,
                    status: 'error' as const,
                    message: errorMessage,
                    fullOutput: fullOutput
                })),
                totalTests: this.discoveredTests.length,
                passedTests: 0,
                failedTests: 0,
                skippedTests: 0,
                command: 'mvn test'
            };
        }
        
        return result;
    }

    private parseTestOutput(stdout: string, stderr: string, directory: string): TestResult {
        let tests: TestCase[] = [];
        const output = stdout + '\n' + stderr; // Combined output for validation
        
        // Parse directly from console output (more reliable than XML files)
        console.log(`[Java Adapter] Parsing console output directly`);
        tests = this.parseMavenConsoleOutput(stdout, stderr);

        // Filter to only include tests that were discovered
        // This prevents phantom "Failed Test 1" entries from appearing
        const discoveredTestNames = new Set(this.discoveredTests.map(t => t.name));
        
        // Debug logging to help diagnose matching issues
        console.log(`[Java Adapter] Discovered tests: ${Array.from(discoveredTestNames).join(', ')}`);
        console.log(`[Java Adapter] Parsed tests before filtering: ${tests.map(t => t.name).join(', ')}`);
        
        const filteredTests = tests.filter(test => discoveredTestNames.has(test.name));
        
        // Log which tests were filtered out
        const filteredOut = tests.filter(test => !discoveredTestNames.has(test.name));
        if (filteredOut.length > 0) {
            console.warn(`[Java Adapter] Filtered out ${filteredOut.length} tests that weren't discovered: ${filteredOut.map(t => t.name).join(', ')}`);
        }
        
        tests = filteredTests;

        // Add any discovered tests that weren't in the parsed results as "passed"
        // Maven Surefire only outputs individual lines for failed/error/skipped tests by default
        // Tests that passed are not shown individually, so we infer them from the summary
        const parsedTestNames = new Set(tests.map(t => t.name));
        for (const discoveredTest of this.discoveredTests) {
            if (!parsedTestNames.has(discoveredTest.name)) {
                // This test was discovered but not in the output, assume it passed
                // This is the standard Maven behavior - passed tests are not reported individually
                console.log(`[Java Adapter] Test ${discoveredTest.name} not in output, inferring passed status`);
                tests.push({
                    name: discoveredTest.name,
                    status: 'passed'
                });
            }
        }

        const passedTests = tests.filter(t => t.status === 'passed').length;
        const failedTests = tests.filter(t => t.status === 'failed').length;
        const skippedTests = tests.filter(t => t.status === 'skipped').length;

        // Validate against Maven's summary line if present
        // Pattern: "Tests run: 3, Failures: 1, Errors: 0, Skipped: 0"
        const summaryMatch = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/.exec(output);
        if (summaryMatch) {
            const [, totalRun, failures, errors, skipped] = summaryMatch;
            const expectedTotal = parseInt(totalRun);
            const expectedFailed = parseInt(failures) + parseInt(errors);
            const expectedSkipped = parseInt(skipped);
            const expectedPassed = expectedTotal - expectedFailed - expectedSkipped;
            
            console.log(`[Java Adapter] Maven summary: ${totalRun} run, ${failures} failures, ${errors} errors, ${skipped} skipped`);
            console.log(`[Java Adapter] Our counts: ${tests.length} total, ${passedTests} passed, ${failedTests} failed, ${skippedTests} skipped`);
            
            // Warn if counts don't match (but don't fail - our inference should be correct)
            if (tests.length !== expectedTotal) {
                console.warn(`[Java Adapter] Test count mismatch: expected ${expectedTotal}, got ${tests.length}`);
            }
            if (passedTests !== expectedPassed) {
                console.warn(`[Java Adapter] Passed test count mismatch: expected ${expectedPassed}, got ${passedTests}`);
            }
        }

        return {
            tests,
            totalTests: tests.length,
            passedTests,
            failedTests,
            skippedTests
        };
    }

    private parseJUnitXML(xmlContent: string): TestCase[] {
        const tests: TestCase[] = [];
        
        // Simple regex-based XML parsing (for production, consider using xml2js)
        const testCaseRegex = /<testcase[^>]*name="([^"]*)"[^>]*classname="([^"]*)"[^>]*time="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g;
        
        let match;
        while ((match = testCaseRegex.exec(xmlContent)) !== null) {
            const [, name, className, time, content] = match;
            console.log(`[Java Adapter] XML parsing: name="${name}", className="${className}"`);
            const fullName = `${className}.${name}`;
            
            let status: 'passed' | 'failed' | 'skipped' = 'passed';
            let message = '';
            let expected = '';
            let actual = '';
            let fullOutput = ''; // Individual test output
            
            if (content.includes('<failure')) {
                status = 'failed';
                const failureMatch = /<failure[^>]*message="([^"]*)"[^>]*>([\s\S]*?)<\/failure>/.exec(content);
                if (failureMatch) {
                    const shortMessage = decodeXmlEntities(failureMatch[1]);
                    const fullMessage = decodeXmlEntities(failureMatch[2]);
                    
                    // Store the full stack trace for this test
                    fullOutput = fullMessage;
                    
                    // Determine if this is an assertion failure or other error
                    const isAssertionError = /AssertionError|assert|expected/i.test(shortMessage) || 
                                            /expected.*but was|expected.*actual/i.test(fullMessage);
                    
                    if (isAssertionError) {
                        // Clean assertion failure - extract expected/actual
                        const result = this.parseJavaAssertion(shortMessage, fullMessage);
                        message = result.message;
                        expected = result.expected;
                        actual = result.actual;
                    } else {
                        // Non-assertion error - provide full context
                        message = this.parseJavaError(shortMessage, fullMessage);
                    }
                }
            } else if (content.includes('<error')) {
                status = 'failed';
                const errorMatch = /<error[^>]*message="([^"]*)"[^>]*>([\s\S]*?)<\/error>/.exec(content);
                if (errorMatch) {
                    const shortMessage = decodeXmlEntities(errorMatch[1]);
                    const fullMessage = decodeXmlEntities(errorMatch[2]);
                    
                    // Store the full stack trace for this test
                    fullOutput = fullMessage;
                    
                    // Errors are always non-assertion (NullPointerException, etc.)
                    message = this.parseJavaError(shortMessage, fullMessage);
                }
            } else if (content.includes('<skipped')) {
                status = 'skipped';
            }
            
            tests.push({
                name: fullName,
                status,
                duration: Math.round(parseFloat(time) * 1000),
                message: message || undefined,
                expected: expected || undefined,
                actual: actual || undefined,
                fullOutput: fullOutput || undefined // Individual test's stack trace
            });
        }
        
        return tests;
    }

    private parseMavenConsoleOutput(stdout: string, stderr: string): TestCase[] {
        const tests: TestCase[] = [];
        const output = stdout + '\n' + stderr;
        
        console.log(`[Java Adapter] Parsing Maven console output (${output.length} chars)`);
        
        // Check for compilation errors first
        if (output.includes('[ERROR] COMPILATION ERROR') || output.includes('BUILD FAILURE')) {
            // Check if it's a compilation error (not a test failure)
            const compilationErrorMatch = /\[ERROR\] COMPILATION ERROR/i.test(output);
            const hasTestResults = /Tests run: \d+/.test(output);
            
            if (compilationErrorMatch && !hasTestResults) {
                // This is a compilation error, not a test failure
                // Extract compilation error details
                const errorDetails = this.extractCompilationError(output);
                
                // Return all discovered tests as errors with compilation details
                return this.discoveredTests.map(test => ({
                    name: test.name,
                    status: 'error' as const,
                    message: errorDetails.message,
                    fullOutput: errorDetails.fullOutput
                }));
            }
        }
        
        // Parse Maven Surefire console output
        // Pattern: testMethodName(ClassName)  Time elapsed: X.XXX sec  <<< FAILURE!
        // Also handles: testMethodName(ClassName)  Time elapsed: X.XXX s  <<< FAILURE!
        // The [ERROR] prefix may appear in the line but we don't need to match it
        // Use \s+ to handle variable whitespace (spaces, tabs, etc.)
        const testResultPattern = /(\w+)\((\w+)\)\s+Time elapsed:\s+([\d.]+)\s+s(?:ec)?(?:\s+<<<\s+(FAILURE|ERROR)!)?/gm;
        
        let match;
        let matchCount = 0;
        while ((match = testResultPattern.exec(output)) !== null) {
            matchCount++;
            const [fullMatch, methodName, className, timeStr, result] = match;
            const fullName = `${className}.${methodName}`;
            const duration = Math.round(parseFloat(timeStr) * 1000);
            
            console.log(`[Java Adapter] Match ${matchCount}: "${fullMatch.substring(0, 80)}..."`);
            console.log(`[Java Adapter] Parsed test from Maven output: ${fullName} (status: ${result || 'passed'})`);
            
            let status: 'passed' | 'failed' | 'skipped' = 'passed';
            let message = '';
            let expected = '';
            let actual = '';
            let fullOutput = '';
            
            if (result === 'FAILURE' || result === 'ERROR') {
                status = 'failed';
                
                // Extract the failure section for this specific test
                // Pattern: testMethodName(ClassName) ... followed by exception and stack trace
                // Stop at the next test result line, "Results :" summary, or end of output
                const failurePattern = new RegExp(
                    `${methodName}\\(${className}\\)[\\s\\S]*?(?:org\\.junit\\.[\\w.]+|java\\.lang\\.[\\w.]+):[\\s\\S]*?(?=\\n\\w+\\(\\w+\\)\\s+Time elapsed:|\\nResults :|$)`,
                    'i'
                );
                const failureMatch = failurePattern.exec(output);
                
                if (failureMatch) {
                    fullOutput = failureMatch[0].trim();
                    
                    // Check if this is an assertion failure
                    const assertionMatch = /^(org\.junit\.\w+(?:Failure|Error)):\s*(.+?)$/m.exec(fullOutput);
                    
                    if (assertionMatch) {
                        const exceptionType = assertionMatch[1];
                        const exceptionMessage = assertionMatch[2];
                        
                        // Check if it's a comparison failure (assertion)
                        if (exceptionType.includes('Comparison') || exceptionType.includes('AssertionError') || 
                            exceptionMessage.includes('expected:') || exceptionMessage.includes('but was:')) {
                            
                            // Extract expected and actual from the message
                            const expectedActualMatch = /expected:\s*<\[?([^\]>]+)\]?>\s+but was:\s*<\[?([^\]>]+)\]?>/i.exec(exceptionMessage);
                            if (expectedActualMatch) {
                                expected = expectedActualMatch[1].trim();
                                actual = expectedActualMatch[2].trim();
                                message = 'Values not equal';
                            } else {
                                message = exceptionMessage;
                            }
                        } else {
                            // Non-assertion error (NullPointerException, etc.)
                            message = this.parseJavaErrorFromConsole(exceptionType, exceptionMessage, fullOutput);
                        }
                    } else {
                        message = 'Test failed';
                    }
                } else {
                    message = 'Test failed - see console output';
                }
            }
            
            tests.push({
                name: fullName,
                status,
                duration,
                message: message || undefined,
                expected: expected || undefined,
                actual: actual || undefined,
                fullOutput: fullOutput || undefined
            });
        }
        
        console.log(`[Java Adapter] Total matches found: ${matchCount}, tests parsed: ${tests.length}`);
        
        return tests;
    }
    
    private parseJavaErrorFromConsole(exceptionType: string, exceptionMessage: string, fullOutput: string): string {
        const messageParts: string[] = [];
        
        // Add exception type and message
        const simpleType = exceptionType.split('.').pop() || exceptionType;
        messageParts.push(`${simpleType}: ${exceptionMessage}`);
        
        // Extract the first relevant stack trace line (user code, not JUnit internals)
        const stackLines = fullOutput.split('\n');
        for (const line of stackLines) {
            const atMatch = /^\s*at\s+([^\(]+)\(([^:]+):(\d+)\)/.exec(line);
            if (atMatch) {
                const method = atMatch[1].trim();
                const file = atMatch[2].trim();
                const lineNum = atMatch[3];
                
                // Skip JUnit and Java internals
                if (!method.startsWith('org.junit') && 
                    !method.startsWith('java.') && 
                    !method.startsWith('jdk.')) {
                    messageParts.push(`  at ${file}:${lineNum}`);
                    break;
                }
            }
        }
        
        return messageParts.join('\n');
    }

    private extractCompilationError(output: string): { message: string; fullOutput: string } {
        const lines = output.split('\n');
        const errorLines: string[] = [];
        let inErrorSection = false;
        let firstError = '';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Start capturing at COMPILATION ERROR
            if (line.includes('[ERROR] COMPILATION ERROR')) {
                inErrorSection = true;
                errorLines.push(line);
                continue;
            }
            
            // Capture error details
            if (inErrorSection) {
                errorLines.push(line);
                
                // Extract the first specific error message
                // Pattern: [ERROR] /path/to/File.java:[line,col] error message
                const errorMatch = /\[ERROR\]\s+([^\[]+\.java):\[(\d+),(\d+)\]\s+(.+)/.exec(line);
                if (errorMatch && !firstError) {
                    const file = errorMatch[1].split('/').pop() || errorMatch[1];
                    const lineNum = errorMatch[2];
                    const errorMsg = errorMatch[4];
                    firstError = `${file}:${lineNum} - ${errorMsg}`;
                }
                
                // Stop at BUILD FAILURE or end of error section
                if (line.includes('[INFO] BUILD FAILURE') || line.includes('[INFO] ---')) {
                    break;
                }
            }
        }
        
        // Create a concise message
        let message = 'Compilation failed';
        if (firstError) {
            message = `Compilation error: ${firstError}`;
        }
        
        // Full output includes the entire error section
        const fullOutput = errorLines.join('\n').trim() || output;
        
        return { message, fullOutput };
    }

    private parseJavaAssertion(shortMessage: string, fullMessage: string): { message: string; expected: string; actual: string } {
        let message = '';
        let expected = '';
        let actual = '';
        
        // Combine both messages for pattern matching
        const combinedMessage = (shortMessage || '') + '\n' + (fullMessage || '');
        
        // Try multiple assertion patterns
        // Pattern 1: "expected:<value> but was:<value>" (most common JUnit format)
        const pattern1 = /expected:\s*<([^>]+)>\s+but was:\s*<([^>]+)>/i.exec(combinedMessage);
        if (pattern1) {
            expected = pattern1[1].trim();
            actual = pattern1[2].trim();
            message = 'Values not equal';
            return { message, expected, actual };
        }
        
        // Pattern 2: "expected [value] but found [value]"
        const pattern2 = /expected\s*\[([^\]]+)\]\s+but (?:found|was)\s*\[([^\]]+)\]/i.exec(combinedMessage);
        if (pattern2) {
            expected = pattern2[1].trim();
            actual = pattern2[2].trim();
            message = 'Values not equal';
            return { message, expected, actual };
        }
        
        // Pattern 3: "expected: value, actual: value"
        const pattern3 = /expected:\s*([^,\n]+).*?actual:\s*([^,\n]+)/i.exec(combinedMessage);
        if (pattern3) {
            expected = pattern3[1].trim();
            actual = pattern3[2].trim();
            message = 'Values not equal';
            return { message, expected, actual };
        }
        
        // Fallback: just use the short message
        message = shortMessage || 'Assertion failed';
        return { message, expected, actual };
    }
    
    private parseJavaError(shortMessage: string, fullMessage: string): string {
        const messageParts: string[] = [];
        
        // Extract error type and message
        const errorTypeMatch = /^([\w\.]+Exception|[\w\.]+Error):\s*(.*)$/m.exec(shortMessage);
        if (errorTypeMatch) {
            const errorType = errorTypeMatch[1].split('.').pop() || errorTypeMatch[1]; // Get simple name
            const errorMsg = errorTypeMatch[2] || shortMessage;
            messageParts.push(`${errorType}: ${errorMsg}`);
        } else {
            messageParts.push(shortMessage);
        }
        
        // Extract stack trace information
        const stackLines = fullMessage.split('\n');
        let foundRelevantStack = false;
        
        for (const line of stackLines) {
            // Look for "at" lines in the stack trace
            const atMatch = /^\s*at\s+([^\(]+)\(([^:]+):(\d+)\)/.exec(line);
            if (atMatch) {
                const method = atMatch[1].trim();
                const file = atMatch[2].trim();
                const lineNum = atMatch[3];
                
                // Skip Java internal classes, focus on user code
                if (!method.startsWith('java.') && 
                    !method.startsWith('sun.') && 
                    !method.startsWith('org.junit') &&
                    !foundRelevantStack) {
                    
                    // Extract class and method name
                    const methodParts = method.split('.');
                    const methodName = methodParts.pop() || method;
                    const className = methodParts.pop() || '';
                    
                    if (className) {
                        messageParts.push(`  at ${file}:${lineNum} in ${className}.${methodName}()`);
                    } else {
                        messageParts.push(`  at ${file}:${lineNum} in ${methodName}()`);
                    }
                    foundRelevantStack = true;
                }
            }
            
            // Look for "Caused by" to show root cause
            const causedByMatch = /^Caused by:\s+([\w\.]+Exception|[\w\.]+Error):\s*(.*)$/m.exec(line);
            if (causedByMatch) {
                const causeType = causedByMatch[1].split('.').pop() || causedByMatch[1];
                const causeMsg = causedByMatch[2];
                messageParts.push(`  Caused by: ${causeType}: ${causeMsg}`);
            }
        }
        
        // If no stack trace was found, include first few lines of full message
        if (!foundRelevantStack && fullMessage && fullMessage !== shortMessage) {
            const firstLines = fullMessage.split('\n').slice(0, 3).join('\n');
            if (firstLines.trim()) {
                messageParts.push(`  ${firstLines.trim()}`);
            }
        }
        
        return messageParts.join('\n');
    }
}

