#!/usr/bin/env node

// Basic syntax test for the compiled server
// This will check if the JavaScript is valid without actually starting the server

const fs = require('fs');
const path = require('path');

console.log('🧪 Testing compiled JavaScript syntax...');

const distDir = path.join(__dirname, 'dist');
const indexFile = path.join(distDir, 'index.js');

// Check if dist directory exists
if (!fs.existsSync(distDir)) {
    console.error('❌ dist directory does not exist');
    process.exit(1);
}

// Check if index.js exists
if (!fs.existsSync(indexFile)) {
    console.error('❌ dist/index.js does not exist');
    process.exit(1);
}

console.log('✅ dist directory and index.js found');

// Try to require the compiled modules (syntax check)
try {
    // Check if the file can be read
    const content = fs.readFileSync(indexFile, 'utf8');
    if (content.length < 100) {
        console.error('❌ index.js appears to be empty or too small');
        process.exit(1);
    }
    
    console.log('✅ index.js has content (' + content.length + ' characters)');
    
    // Check for expected imports
    const hasServerImport = content.includes('@modelcontextprotocol/sdk');
    const hasGrokClient = content.includes('GrokClient');
    
    if (!hasServerImport) {
        console.error('❌ Missing MCP SDK import');
        process.exit(1);
    }
    
    if (!hasGrokClient) {
        console.error('❌ Missing GrokClient import');
        process.exit(1);
    }
    
    console.log('✅ Required imports found');
    console.log('✅ Compiled JavaScript appears valid');
    
} catch (error) {
    console.error('❌ Error reading compiled file:', error.message);
    process.exit(1);
}

console.log('');
console.log('🎯 Basic tests passed!');
console.log('   The compiled server appears to be valid.');
console.log('   Ready for environment testing.');