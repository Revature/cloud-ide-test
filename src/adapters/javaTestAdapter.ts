import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
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
                    // Check if file contains @Test annotation
                    const content = fs.readFileSync(fullPath, 'utf8');
                    if (/^\s*@Test\b/m.test(content)) {
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
                
                // Find test classes (only capture the first/top-level class)
                if (!currentClass) {
                    const classMatch = /\b(?:(?:public|private|protected|static|final|abstract)\s+)*class\s+(\w+)/i.exec(line);
                    if (classMatch) {
                        currentClass = classMatch[1];
                    }
                }
                
                // Find test methods - marked with test annotations
                // Support JUnit 4 (@Test) and JUnit 5 (@Test, @ParameterizedTest, @RepeatedTest, @TestFactory)
                const testAnnotations = ['@Test', '@ParameterizedTest', '@RepeatedTest', '@TestFactory'];
                const hasTestAnnotation = testAnnotations.some(ann => line.trim().startsWith(ann));
                
                if (hasTestAnnotation) {
                    // Look ahead for method signature - may have multiple annotations or blank lines
                    // Search up to 30 lines ahead to handle verbose javadoc and multiple annotations
                    for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
                        const nextLine = lines[j].trim();
                        
                        // Skip blank lines, comments, and other annotations
                        if (nextLine === '' || 
                            nextLine.startsWith('//') || 
                            nextLine.startsWith('/*') || 
                            nextLine.startsWith('*') || 
                            nextLine.startsWith('@')) {
                            continue;
                        }
                        
                        // Match method signatures with any modifiers and return types:
                        // - "public void methodName(" - standard
                        // - "void methodName(" - package-private
                        // - "public String methodName(" - non-void return
                        // - "static final void methodName(" - multiple modifiers
                        const methodMatch = /(?:public|private|protected|static|final|\s)*(?:\w+\s+)?(\w+)\s*\(/.exec(nextLine);
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

        // Parse Surefire XML reports
        const result = await this.parseSurefireReports(directory, stdout, stderr);
        
        // Generate full output for display (cleans ANSI codes automatically)
        const fullOutput = generateFullOutput(stdout, stderr);
        result.tests = result.tests.map(test => ({
            ...test,
            fullOutput: test.fullOutput ? cleanAnsiEscapeCodes(test.fullOutput) : fullOutput
        }));
        
        // Add the command to the result
        result.command = 'mvn test';
        
        return result;
    }

    private async parseSurefireReports(directory: string, stdout: string, stderr: string): Promise<TestResult> {
        const reportsDir = path.join(directory, 'target', 'surefire-reports');
        
        // Check if reports directory exists
        if (!fs.existsSync(reportsDir)) {
            console.warn('[Java Adapter] Surefire reports directory not found');
            return {
                tests: [],
                totalTests: 0,
                passedTests: 0,
                failedTests: 0,
                skippedTests: 0
            };
        }

        const tests: TestCase[] = [];
        
        // Find all TEST-*.xml files
        const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('TEST-') && f.endsWith('.xml'));
        
        console.log(`[Java Adapter] Found ${files.length} Surefire report files`);
        
        for (const file of files) {
            const xmlPath = path.join(reportsDir, file);
            const xmlContent = fs.readFileSync(xmlPath, 'utf8');
            
            try {
                const parsed = await xml2js.parseStringPromise(xmlContent);
                const testsFromFile = this.extractTestsFromXml(parsed);
                tests.push(...testsFromFile);
            } catch (error) {
                console.error(`[Java Adapter] Failed to parse ${file}:`, error);
            }
        }

        const passedTests = tests.filter(t => t.status === 'passed').length;
        const failedTests = tests.filter(t => t.status === 'failed').length;
        const skippedTests = tests.filter(t => t.status === 'skipped').length;

        return {
            tests,
            totalTests: tests.length,
            passedTests,
            failedTests,
            skippedTests
        };
    }

    private extractTestsFromXml(parsed: any): TestCase[] {
        const tests: TestCase[] = [];
        
        if (!parsed.testsuite || !parsed.testsuite.testcase) {
            return tests;
        }

        const testcases = Array.isArray(parsed.testsuite.testcase) 
            ? parsed.testsuite.testcase 
            : [parsed.testsuite.testcase];

        for (const testcase of testcases) {
            const className = testcase.$.classname;
            const methodName = testcase.$.name;
            const time = parseFloat(testcase.$.time || '0');
            const fullName = `${className}.${methodName}`;

            let status: 'passed' | 'failed' | 'skipped' = 'passed';
            let message: string | undefined;
            let expected: string | undefined;
            let actual: string | undefined;
            let fullOutput: string | undefined;

            // Check for failure
            if (testcase.failure) {
                status = 'failed';
                const failure = Array.isArray(testcase.failure) ? testcase.failure[0] : testcase.failure;
                const shortMessage = failure.$.message || '';
                const fullMessage = failure._ || '';
                
                fullOutput = fullMessage;
                
                // Determine if this is an assertion failure or other error
                const isAssertionError = /AssertionError|assert|expected/i.test(shortMessage) || 
                                        /expected.*but was|expected.*actual/i.test(fullMessage);
                
                if (isAssertionError) {
                    const result = this.parseJavaAssertion(shortMessage, fullMessage);
                    message = result.message;
                    expected = result.expected;
                    actual = result.actual;
                } else {
                    message = this.parseJavaError(shortMessage, fullMessage);
                }
            }
            // Check for error
            else if (testcase.error) {
                status = 'failed';
                const error = Array.isArray(testcase.error) ? testcase.error[0] : testcase.error;
                const shortMessage = error.$.message || '';
                const fullMessage = error._ || '';
                
                fullOutput = fullMessage;
                message = this.parseJavaError(shortMessage, fullMessage);
            }
            // Check for skipped
            else if (testcase.skipped) {
                status = 'skipped';
            }

            tests.push({
                name: fullName,
                status,
                duration: Math.round(time * 1000),
                message,
                expected,
                actual,
                fullOutput
            });
        }

        return tests;
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