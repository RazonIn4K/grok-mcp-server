import { strict as assert } from 'assert';
import process from 'process';

// Set dummy API key to prevent server from exiting on import
process.env.XAI_API_KEY = 'dummy-key-for-testing';
process.env.LOG_LEVEL = 'silent'; // Suppress logs

console.log('🧪 Starting Grok 4 Model Support Tests...');

// Mock Transport
class MockTransport {
    constructor() {
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.sentMessages = [];
    }
    
    async start() {}
    
    async send(message) {
        this.sentMessages.push(message);
    }
    
    async close() {}
    
    // Helper to simulate incoming message
    receive(message) {
        if (this.onmessage) {
            this.onmessage(message);
        }
    }
}

async function runTests() {
    try {
        // Dynamic import to ensure env vars are set first
        const { server, grokClient } = await import('./dist/index.js');
        
        // Mock GrokClient methods
        grokClient.getModels = async () => {
            return ['grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning', 'grok-code-fast-1', 'grok-4', 'grok-3'];
        };
        
        grokClient.ask = async (question, context, systemPrompt, options) => {
            return `Mock response for model: ${options?.model || 'default'}`;
        };

        const transport = new MockTransport();
        await server.connect(transport);
        console.log('✅ Server connected to mock transport');

        // Test 1: List Tools (Verify grok_ask has model param)
        console.log('\n📝 Test 1: Verifying grok_ask tool definition...');
        transport.receive({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
        });

        // Wait a bit for response (async)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const listResponse = transport.sentMessages.find(m => m.id === 1);
        assert(listResponse, 'No response for tools/list');
        assert(listResponse.result, 'Error in tools/list response');
        
        const grokAsk = listResponse.result.tools.find(t => t.name === 'grok_ask');
        assert(grokAsk, 'grok_ask tool not found');
        
        const modelParam = grokAsk.inputSchema.properties.model;
        assert(modelParam, 'model parameter missing in grok_ask');
        console.log('✅ grok_ask has model parameter');

        // Test 2: Call grok_models
        console.log('\n📝 Test 2: Calling grok_models...');
        transport.receive({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'grok_models',
                arguments: {}
            }
        });

        await new Promise(resolve => setTimeout(resolve, 100));
        
        const modelsResponse = transport.sentMessages.find(m => m.id === 2);
        assert(modelsResponse, 'No response for grok_models');
        assert(!modelsResponse.error, `grok_models returned error: ${JSON.stringify(modelsResponse.error)}`);
        
        const content = modelsResponse.result.content[0].text;
        assert(content.includes('grok-code-fast-1'), 'Response missing new model grok-code-fast-1');
        console.log('✅ grok_models returned expected models');

        // Test 3: Call grok_ask with specific model
        console.log('\n📝 Test 3: Calling grok_ask with specific model...');
        const testModel = 'grok-code-fast-1';
        transport.receive({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
                name: 'grok_ask',
                arguments: {
                    question: 'Test question',
                    model: testModel
                }
            }
        });

        await new Promise(resolve => setTimeout(resolve, 100));
        
        const askResponse = transport.sentMessages.find(m => m.id === 3);
        assert(askResponse, 'No response for grok_ask');
        assert(!askResponse.error, `grok_ask returned error: ${JSON.stringify(askResponse.error)}`);
        
        const askContent = askResponse.result.content[0].text;
        assert(askContent.includes(`Mock response for model: ${testModel}`), 'Mock response did not confirm correct model usage');
        console.log('✅ grok_ask correctly passed model parameter');

        console.log('\n🎉 All tests passed successfully!');
        process.exit(0);

    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

runTests();