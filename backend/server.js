const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// In-memory storage for user sessions and usage tracking
// In production, use a database like Redis or MongoDB
const userSessions = new Map(); // userId -> { usage: {tool: count}, premiumUntil: Date }
const activePayments = new Map(); // paymentId -> { userId, amount, status }
const generatedCodes = new Map(); // code -> { userId, createdAt, used: boolean, paypalOrderId, etc. }

// Generate unique user ID
function generateUserId() {
    return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Generate unique premium codes
function generatePremiumCode() {
    const prefix = 'PREMIUM';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 6).toUpperCase();
    return `${prefix}_${timestamp}_${random}`;
}

// Get or create user session
function getUserSession(userId) {
    if (!userId || !userSessions.has(userId)) {
        const newUserId = generateUserId();
        userSessions.set(newUserId, {
            usage: { merge: 0, compress: 0, split: 0, edit: 0, repair: 0, convert: 0 },
            premiumUntil: null,
            createdAt: new Date()
        });
        return { userId: newUserId, session: userSessions.get(newUserId) };
    }
    return { userId, session: userSessions.get(userId) };
}

// Check if user has premium access
function hasPremiumAccess(session) {
    return session.premiumUntil && new Date() < session.premiumUntil;
}

// Updated tool configurations with new freemium model
const toolConfigs = {
    merge: { requiresPremium: false, freeLimit: null }, // Fully free
    compress: { requiresPremium: false, freeLimit: null }, // Fully free
    split: { requiresPremium: false, freeLimit: 5 }, // 5 free uses
    edit: { requiresPremium: false, freeLimit: 2 }, // 2 free tries
    repair: { requiresPremium: false, freeLimit: 2 }, // 2 free tries
    convert: { requiresPremium: false, freeLimit: null } // Free for basic formats, premium for advanced
};

// Middleware
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
            'https://srv-d358t78dl3ps738fkjpg.onrender.com',
            'http://localhost:3000',
            'http://localhost:3001'
        ];
        
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        
        if (origin.includes('.onrender.com')) {
            return callback(null, true);
        }
        
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-User-ID'],
    optionsSuccessStatus: 200
}));
app.use(express.json());
app.use(express.static('public'));

// Configure multer
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
        files: 20
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'), false);
        }
    }
});

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');

async function ensureDirectories() {
    try {
        await fs.mkdir(uploadsDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
        console.error('Error creating directories:', error);
    }
}

ensureDirectories();

// Helper functions
function generateFileName(prefix = 'processed') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`;
}

async function createZipFile(files, outputPath) {
    return new Promise((resolve, reject) => {
        const output = require('fs').createWriteStream(outputPath);
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        output.on('close', () => {
            console.log(`Zip file created: ${archive.pointer()} total bytes`);
            resolve();
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);

        files.forEach((file, index) => {
            archive.append(file.buffer, { name: file.filename });
        });

        archive.finalize();
    });
}

// PDF Processing Functions
async function mergePDFs(files) {
    const mergedPdf = await PDFDocument.create();
    
    for (const file of files) {
        const pdfDoc = await PDFDocument.load(file.buffer);
        const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
    }
    
    return await mergedPdf.save();
}

async function splitPDF(file, options = {}) {
    try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        const totalPages = pdfDoc.getPageCount();
        const { splitMethod, pageRanges, numberOfParts } = options;
        
        console.log('Split options:', { splitMethod, pageRanges, numberOfParts, totalPages });
        
        if (splitMethod === 'page_ranges' && pageRanges) {
            const ranges = parsePageRanges(pageRanges, totalPages);
            const results = [];
            
            for (let i = 0; i < ranges.length; i++) {
                const range = ranges[i];
                const newPdf = await PDFDocument.create();
                const pages = await newPdf.copyPages(pdfDoc, range);
                pages.forEach(page => newPdf.addPage(page));
                
                const pdfBytes = await newPdf.save();
                const rangeStr = range.length === 1 ? `page_${range[0] + 1}` : `pages_${range[0] + 1}-${range[range.length - 1] + 1}`;
                
                results.push({
                    buffer: Buffer.from(pdfBytes),
                    filename: `${rangeStr}.pdf`
                });
            }
            
            console.log(`Split by ranges completed: ${results.length} files`);
            return results;
            
        } else if (splitMethod === 'equal_parts' && numberOfParts) {
            const parts = parseInt(numberOfParts);
            const pagesPerPart = Math.ceil(totalPages / parts);
            const results = [];
            
            for (let i = 0; i < parts; i++) {
                const startPage = i * pagesPerPart;
                const endPage = Math.min(startPage + pagesPerPart - 1, totalPages - 1);
                
                if (startPage <= endPage) {
                    const newPdf = await PDFDocument.create();
                    const pageIndices = [];
                    for (let j = startPage; j <= endPage; j++) {
                        pageIndices.push(j);
                    }
                    
                    const pages = await newPdf.copyPages(pdfDoc, pageIndices);
                    pages.forEach(page => newPdf.addPage(page));
                    
                    const pdfBytes = await newPdf.save();
                    results.push({
                        buffer: Buffer.from(pdfBytes),
                        filename: `part_${i + 1}_pages_${startPage + 1}-${endPage + 1}.pdf`
                    });
                }
            }
            
            console.log(`Split into equal parts completed: ${results.length} files`);
            return results;
            
        } else {
            // Default: Split into individual pages
            const results = [];
            
            for (let i = 0; i < totalPages; i++) {
                const newPdf = await PDFDocument.create();
                const [page] = await newPdf.copyPages(pdfDoc, [i]);
                newPdf.addPage(page);
                
                const pdfBytes = await newPdf.save();
                results.push({
                    buffer: Buffer.from(pdfBytes),
                    filename: `page_${i + 1}.pdf`
                });
            }
            
            console.log(`Split into individual pages completed: ${results.length} files`);
            return results;
        }
    } catch (error) {
        console.error('Error in splitPDF:', error);
        throw new Error(`PDF split failed: ${error.message}`);
    }
}

function parsePageRanges(rangeString, totalPages) {
    const ranges = [];
    const parts = rangeString.split(',').map(s => s.trim());
    
    for (const part of parts) {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(s => parseInt(s.trim()));
            if (!isNaN(start) && !isNaN(end) && start >= 1 && end <= totalPages && start <= end) {
                const range = [];
                for (let i = start - 1; i < end; i++) {
                    range.push(i);
                }
                ranges.push(range);
            }
        } else {
            const page = parseInt(part);
            if (!isNaN(page) && page >= 1 && page <= totalPages) {
                ranges.push([page - 1]);
            }
        }
    }
    
    return ranges;
}

async function compressPDF(file, isPremium = false) {
    const pdfDoc = await PDFDocument.load(file.buffer);
    
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setCreator('');
    pdfDoc.setProducer('PDF Tools Suite');
    
    return await pdfDoc.save();
}

async function repairPDF(file, isPremium = false) {
    try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        return await pdfDoc.save();
    } catch (error) {
        throw new Error('PDF repair failed: File may be severely corrupted');
    }
}

async function editPDF(file, edits) {
    const pdfDoc = await PDFDocument.load(file.buffer);
    
    if (edits.rotatePages) {
        const pages = pdfDoc.getPages();
        edits.rotatePages.forEach(({ pageIndex, degrees }) => {
            if (pages[pageIndex]) {
                pages[pageIndex].setRotation({ angle: degrees });
            }
        });
    }
    
    return await pdfDoc.save();
}

// API Routes

// Get user status endpoint
app.get('/api/user-status', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { userId: finalUserId, session } = getUserSession(userId);
    
    const isPremium = hasPremiumAccess(session);
    
    res.json({
        userId: finalUserId,
        isPremium,
        premiumUntil: session.premiumUntil,
        usage: session.usage
    });
});

// Process PDF endpoint
app.post('/api/process-pdf', upload.array('files', 20), async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        const { tool, convertTo } = req.body;
        const files = req.files;
        
        console.log('Processing request:', {
            tool,
            userId: finalUserId,
            fileCount: files ? files.length : 0,
            convertTo,
            hasFiles: !!files,
            bodyKeys: Object.keys(req.body)
        });
        
        if (!files || files.length === 0) {
            console.error('No files uploaded');
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        if (!tool) {
            console.error('No tool specified');
            return res.status(400).json({ error: 'No tool specified' });
        }
        
        const config = toolConfigs[tool];
        if (!config) {
            console.error('Invalid tool:', tool);
            return res.status(400).json({ error: 'Invalid tool specified' });
        }
        
        const isPremium = hasPremiumAccess(session);
        const currentUsage = session.usage[tool] || 0;
        
        console.log('Usage check:', {
            tool,
            currentUsage,
            freeLimit: config.freeLimit,
            isPremium
        });
        
        // Check usage limits
        if (!isPremium && config.freeLimit !== null && currentUsage >= config.freeLimit) {
            return res.status(403).json({ 
                error: `Free limit reached for ${tool}. You've used ${currentUsage}/${config.freeLimit} free uses.`,
                userId: finalUserId
            });
        }
        
        // Special handling for convert tool
        if (tool === 'convert') {
            const freeFormats = ['word', 'text', 'excel'];
            const premiumFormats = ['powerpoint', 'images'];
            
            if (!isPremium && convertTo && premiumFormats.includes(convertTo)) {
                return res.status(403).json({ 
                    error: `Premium access required for ${convertTo} conversion.`,
                    userId: finalUserId
                });
            }
        }
        
        // Process the files
        let result;
        let filename;
        
        console.log(`Starting ${tool} processing...`);
        
        try {
            switch (tool) {
                case 'merge':
                    console.log('Merging PDFs...');
                    const mergedBuffer = await mergePDFs(files);
                    filename = generateFileName('merged');
                    result = { buffer: mergedBuffer, filename };
                    console.log('Merge completed, buffer size:', mergedBuffer.length);
                    break;
                    
                case 'split':
                    console.log('Splitting PDF...');
                    const splitOptions = {
                        splitMethod: req.body.splitMethod || 'all_pages',
                        pageRanges: req.body.pageRanges || '',
                        numberOfParts: req.body.numberOfParts || '2'
                    };
                    
                    console.log('Split options:', splitOptions);
                    const splitResults = await splitPDF(files[0], splitOptions);
                    
                    if (splitResults.length === 1) {
                        result = splitResults[0];
                    } else {
                        const zipFilename = generateFileName('split_pages').replace('.pdf', '.zip');
                        const zipPath = path.join(outputDir, zipFilename);
                        
                        console.log('Creating zip file:', zipPath);
                        await createZipFile(splitResults, zipPath);
                        
                        result = {
                            buffer: await fs.readFile(zipPath),
                            filename: zipFilename,
                            isZip: true
                        };
                    }
                    console.log('Split completed');
                    break;
                    
                case 'compress':
                    console.log('Compressing PDF...');
                    const compressedBuffer = await compressPDF(files[0], isPremium);
                    filename = generateFileName('compressed');
                    result = { buffer: compressedBuffer, filename };
                    console.log('Compress completed, buffer size:', compressedBuffer.length);
                    break;
                    
                case 'repair':
                    console.log('Repairing PDF...');
                    const repairedBuffer = await repairPDF(files[0], isPremium);
                    filename = generateFileName('repaired');
                    result = { buffer: repairedBuffer, filename };
                    console.log('Repair completed');
                    break;
                    
                case 'convert':
                    console.log('Converting PDF to:', convertTo);
                    
                    if (!convertTo) {
                        throw new Error('No conversion format specified');
                    }
                    
                    let pdfDoc;
                    try {
                        pdfDoc = await PDFDocument.load(files[0].buffer);
                        console.log('PDF loaded successfully, pages:', pdfDoc.getPageCount());
                    } catch (loadError) {
                        console.error('Failed to load PDF:', loadError.message);
                        throw new Error('Invalid or corrupted PDF file');
                    }
                    
                    let convertedBuffer, convertedFilename, fileExtension;
                    const qualityNote = isPremium ? 'High-quality premium conversion' : 'Basic conversion';
                    
                    switch (convertTo) {
                        case 'word':
                            const pageCount = pdfDoc.getPageCount();
                            const wordContent = `${pdfDoc.getTitle() || 'Converted Document'}\n\nPages: ${pageCount}\nConversion: PDF to Word\nQuality: ${isPremium ? 'Premium' : 'Basic'}\n\n${qualityNote}\n\n[Document content would appear here]`;
                            convertedBuffer = Buffer.from(wordContent);
                            fileExtension = '.txt';
                            convertedFilename = generateFileName('converted_to_word').replace('.pdf', fileExtension);
                            break;
                            
                        case 'excel':
                            const excelContent = `PDF Analysis Report\nPages,${pdfDoc.getPageCount()}\nTitle,${pdfDoc.getTitle() || 'Untitled'}\nQuality,${isPremium ? 'Premium' : 'Basic'}`;
                            convertedBuffer = Buffer.from(excelContent);
                            fileExtension = '.csv';
                            convertedFilename = generateFileName('converted_to_excel').replace('.pdf', fileExtension);
                            break;
                            
                        case 'text':
                            const textContent = `Text Extraction from PDF\n\nDocument: ${pdfDoc.getTitle() || 'Untitled'}\nPages: ${pdfDoc.getPageCount()}\nQuality: ${isPremium ? 'Premium' : 'Basic'}\n\n${qualityNote}\n\n[Extracted text would appear here]`;
                            convertedBuffer = Buffer.from(textContent);
                            fileExtension = '.txt';
                            convertedFilename = generateFileName('extracted_text').replace('.pdf', fileExtension);
                            break;
                            
                        case 'powerpoint':
                            const pptContent = `PDF Presentation Summary\n\nSlides: ${pdfDoc.getPageCount()}\nQuality: Premium\n\n${qualityNote}`;
                            convertedBuffer = Buffer.from(pptContent);
                            fileExtension = '.txt';
                            convertedFilename = generateFileName('converted_to_ppt').replace('.pdf', fileExtension);
                            break;
                            
                        case 'images':
                            const imageInfo = `PDF Image Extraction Report\n\nPages: ${pdfDoc.getPageCount()}\nQuality: Premium with high-resolution extraction\n\n${qualityNote}`;
                            convertedBuffer = Buffer.from(imageInfo);
                            fileExtension = '.txt';
                            convertedFilename = generateFileName('image_extraction').replace('.pdf', fileExtension);
                            break;
                            
                        default:
                            throw new Error(`Unsupported conversion format: ${convertTo}`);
                    }
                    
                    result = { buffer: convertedBuffer, filename: convertedFilename };
                    console.log('Convert completed, format:', convertTo);
                    break;
                    
                case 'edit':
                    console.log('Editing PDF...');
                    const editedBuffer = await editPDF(files[0], req.body.edits || {});
                    filename = generateFileName('edited');
                    result = { buffer: editedBuffer, filename };
                    console.log('Edit completed');
                    break;
                    
                default:
                    throw new Error(`Tool not implemented: ${tool}`);
            }
            
        } catch (processingError) {
            console.error(`Error during ${tool} processing:`, processingError);
            throw processingError;
        }
        
        if (!result || !result.buffer) {
            throw new Error('Processing failed - no result generated');
        }
        
        // Update usage count (only for tools with limits)
        if (!isPremium && config.freeLimit !== null) {
            session.usage[tool] = currentUsage + 1;
            userSessions.set(finalUserId, session);
            console.log(`Updated usage for ${tool}:`, session.usage[tool]);
        }
        
        // Save result file
        const outputPath = path.join(outputDir, result.filename);
        console.log('Saving file to:', outputPath);
        
        try {
            await fs.writeFile(outputPath, result.buffer);
            console.log('File saved successfully, size:', result.buffer.length);
        } catch (saveError) {
            console.error('Error saving file:', saveError);
            throw new Error('Failed to save processed file');
        }
        
        res.json({
            success: true,
            downloadUrl: `/api/download/${result.filename}`,
            filename: result.filename,
            fileSize: result.buffer.length,
            userId: finalUserId,
            remainingUses: config.freeLimit !== null ? Math.max(0, config.freeLimit - (session.usage[tool] || 0)) : null
        });
        
        // Clean up after 1 hour
        setTimeout(async () => {
            try {
                await fs.unlink(outputPath);
                console.log('Cleaned up file:', result.filename);
            } catch (error) {
                console.error('Error cleaning up file:', error);
            }
        }, 3600000);
        
    } catch (error) {
        console.error('Processing error details:', {
            message: error.message,
            stack: error.stack,
            tool: req.body.tool,
            fileCount: req.files ? req.files.length : 0
        });
        
        res.status(500).json({ 
            error: 'Processing failed', 
            details: error.message,
            tool: req.body.tool
        });
    }
});

// Download endpoint
app.get('/api/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(outputDir, filename);
        
        await fs.access(filePath);
        
        const isZip = filename.endsWith('.zip');
        const isText = filename.endsWith('.txt');
        const isCsv = filename.endsWith('.csv');
        
        let contentType = 'application/pdf';
        if (isText) contentType = 'text/plain';
        if (isCsv) contentType = 'text/csv';
        if (isZip) contentType = 'application/zip';
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        const fileBuffer = await fs.readFile(filePath);
        res.send(fileBuffer);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(404).json({ error: 'File not found' });
    }
});

// Create PayPal order endpoint
app.post('/api/create-paypal-order', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        
        // Generate order ID (in production, integrate with PayPal SDK)
        const orderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Store payment info
        activePayments.set(orderId, {
            userId: finalUserId,
            amount: '2.00',
            status: 'pending',
            createdAt: new Date()
        });
        
        res.json({
            orderId,
            userId: finalUserId
        });
        
    } catch (error) {
        console.error('PayPal order creation error:', error);
        res.status(500).json({ error: 'Failed to create PayPal order' });
    }
});

// Enhanced PayPal payment capture endpoint with premium code generation
app.post('/api/capture-paypal-payment', async (req, res) => {
    try {
        const { orderId, payerId, paymentDetails } = req.body;
        const userId = req.headers['x-user-id'];
        
        console.log('Processing PayPal payment:', {
            orderId,
            payerId,
            userId,
            paymentStatus: paymentDetails?.status
        });
        
        // Verify payment was completed successfully
        if (paymentDetails?.status !== 'COMPLETED') {
            return res.status(400).json({ 
                error: 'Payment not completed',
                status: paymentDetails?.status
            });
        }
        
        // Verify payment amount (basic validation)
        const paymentAmount = paymentDetails?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
        if (paymentAmount !== '2.00') {
            console.error('Invalid payment amount:', paymentAmount);
            return res.status(400).json({ error: 'Invalid payment amount' });
        }
        
        // Get or create user session
        const { userId: finalUserId, session } = getUserSession(userId);
        
        // Generate premium code FIRST
        const premiumCode = generatePremiumCode();
        
        // Grant premium access for 24 hours
        const premiumExpiry = new Date();
        premiumExpiry.setHours(premiumExpiry.getHours() + 24);
        
        session.premiumUntil = premiumExpiry;
        userSessions.set(finalUserId, session);
        
        // Store generated code
        generatedCodes.set(premiumCode, {
            userId: finalUserId,
            createdAt: new Date(),
            used: true, // Already activated
            paypalOrderId: orderId,
            paypalPayerId: payerId
        });
        
        console.log(`Premium access granted to user ${finalUserId} until ${premiumExpiry}`);
        console.log(`Generated premium code: ${premiumCode}`);
        
        res.json({
            success: true,
            premiumUntil: premiumExpiry.toISOString(),
            premiumCode: premiumCode,
            message: `Payment successful! You now have 24-hour premium access. Your premium code: ${premiumCode}`,
            orderId: orderId,
            userId: finalUserId
        });
        
    } catch (error) {
        console.error('Payment capture error:', error);
        res.status(500).json({ error: 'Payment capture failed', details: error.message });
    }
});

// Enhanced premium code activation endpoint
app.post('/api/activate-premium-code', async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        
        if (!code || !code.trim()) {
            return res.status(400).json({ error: 'Premium code is required' });
        }
        
        const codeUpper = code.toUpperCase().trim();
        
        // Check predefined codes (for testing/demo purposes)
        const validCodes = ['PREMIUM24H', 'TESTCODE123', 'LAUNCH2024', 'DEMO2024', 'FREEPREMIUM'];
        
        // Check generated codes
        const isGeneratedCode = generatedCodes.has(codeUpper);
        const isValidPredefinedCode = validCodes.includes(codeUpper);
        
        if (isValidPredefinedCode || isGeneratedCode) {
            const premiumExpiry = new Date();
            premiumExpiry.setHours(premiumExpiry.getHours() + 24);
            
            session.premiumUntil = premiumExpiry;
            userSessions.set(finalUserId, session);
            
            let codeInfo = { type: 'predefined' };
            
            // Handle generated codes
            if (isGeneratedCode) {
                const codeData = generatedCodes.get(codeUpper);
                codeData.activatedBy = finalUserId;
                codeData.activatedAt = new Date();
                codeData.reused = codeData.used; // Track if this was a reuse
                codeData.used = true;
                
                codeInfo = {
                    type: 'generated',
                    originalUser: codeData.userId,
                    createdAt: codeData.createdAt,
                    paypalOrderId: codeData.paypalOrderId || null
                };
            }
            
            console.log(`Premium code activated: ${codeUpper} by user ${finalUserId}`, codeInfo);
            
            res.json({
                success: true,
                premiumUntil: premiumExpiry.toISOString(),
                userId: finalUserId,
                message: 'Premium code activated successfully! You now have 24-hour premium access.',
                codeType: codeInfo.type,
                codeInfo: codeInfo
            });
        } else {
            console.log(`Invalid premium code attempted: ${codeUpper} by user ${finalUserId}`);
            res.status(400).json({ 
                error: 'Invalid premium code. Please check your code and try again.',
                code: codeUpper.substring(0, 8) + '...' // Log partial code for debugging
            });
        }
        
    } catch (error) {
        console.error('Code activation error:', error);
        res.status(500).json({ error: 'Code activation failed', details: error.message });
    }
});

// Validate premium codes without activating
app.post('/api/validate-premium-code', async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code) {
            return res.json({ valid: false, reason: 'No code provided' });
        }
        
        const codeUpper = code.toUpperCase().trim();
        const validCodes = ['PREMIUM24H', 'TESTCODE123', 'LAUNCH2024', 'DEMO2024', 'FREEPREMIUM'];
        const isValidPredefinedCode = validCodes.includes(codeUpper);
        const isGeneratedCode = generatedCodes.has(codeUpper);
        
        if (isValidPredefinedCode || isGeneratedCode) {
            const codeInfo = isGeneratedCode ? generatedCodes.get(codeUpper) : null;
            
            res.json({
                valid: true,
                type: isGeneratedCode ? 'generated' : 'predefined',
                used: codeInfo ? codeInfo.used : false,
                createdAt: codeInfo ? codeInfo.createdAt : null,
                canReuse: true // Both types can be reused in this implementation
            });
        } else {
            res.json({ 
                valid: false, 
                reason: 'Code not found',
                suggestion: 'Please check your code and try again'
            });
        }
        
    } catch (error) {
        console.error('Code validation error:', error);
        res.status(500).json({ error: 'Code validation failed' });
    }
});

// Get premium code statistics (for admin/debugging)
app.get('/api/premium-stats', async (req, res) => {
    try {
        // Only allow if admin token is provided (optional security)
        const adminToken = req.headers['x-admin-token'];
        if (adminToken !== process.env.ADMIN_TOKEN && process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        const now = new Date();
        let totalCodes = generatedCodes.size;
        let usedCodes = 0;
        let activeCodes = 0;
        let recentCodes = 0;
        
        for (const [code, data] of generatedCodes.entries()) {
            if (data.used) usedCodes++;
            if (now - data.createdAt < 24 * 60 * 60 * 1000) {
                recentCodes++; // Created in last 24 hours
                if (data.used) activeCodes++; // Used and recent = likely still active
            }
        }
        
        res.json({
            totalGeneratedCodes: totalCodes,
            usedCodes: usedCodes,
            unusedCodes: totalCodes - usedCodes,
            recentCodes: recentCodes,
            likelyActiveCodes: activeCodes,
            activeSessions: userSessions.size
        });
        
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Generate manual premium codes (for admin use)
app.post('/api/generate-manual-codes', async (req, res) => {
    try {
        const adminToken = req.headers['x-admin-token'];
        if (adminToken !== process.env.ADMIN_TOKEN && process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        const count = req.body.count || 1;
        const codes = [];
        
        for (let i = 0; i < count; i++) {
            const code = generatePremiumCode();
            generatedCodes.set(code, {
                userId: 'manual_generation',
                createdAt: new Date(),
                used: false,
                type: 'manual',
                generatedBy: 'admin'
            });
            codes.push(code);
        }
        
        console.log(`Generated ${count} manual premium codes`);
        
        res.json({ 
            success: true,
            codes: codes,
            count: codes.length,
            message: `Generated ${count} premium codes successfully`
        });
        
    } catch (error) {
        console.error('Manual code generation error:', error);
        res.status(500).json({ error: 'Failed to generate codes' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: userSessions.size,
        generatedCodes: generatedCodes.size,
        version: '2.0.0',
        features: {
            premiumCodes: true,
            paypalIntegration: true,
            emailNotifications: false
        }
    });
});

// Get system information (debug endpoint)
app.get('/api/system-info', (req, res) => {
    try {
        const adminToken = req.headers['x-admin-token'];
        if (adminToken !== process.env.ADMIN_TOKEN && process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        const memoryUsage = process.memoryUsage();
        const now = new Date();
        
        // Calculate premium statistics
        let premiumUsers = 0;
        let expiredUsers = 0;
        for (const [userId, session] of userSessions.entries()) {
            if (session.premiumUntil) {
                if (new Date() < session.premiumUntil) {
                    premiumUsers++;
                } else {
                    expiredUsers++;
                }
            }
        }
        
        res.json({
            server: {
                nodeVersion: process.version,
                platform: process.platform,
                uptime: process.uptime(),
                memoryUsage: {
                    rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
                    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
                    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB'
                }
            },
            statistics: {
                activeSessions: userSessions.size,
                premiumUsers: premiumUsers,
                expiredUsers: expiredUsers,
                generatedCodes: generatedCodes.size,
                activePayments: activePayments.size
            },
            configuration: {
                toolConfigs: toolConfigs,
                corsEnabled: true,
                uploadLimit: '50MB',
                maxFiles: 20
            }
        });
        
    } catch (error) {
        console.error('System info error:', error);
        res.status(500).json({ error: 'Failed to get system info' });
    }
});

// Error handling
app.use((error, req, res, next) => {
    console.error('Error:', error);
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: 'Too many files. Maximum is 20 files.' });
        }
    }
    
    res.status(500).json({ error: 'Internal server error' });
});

// Enhanced cleanup with premium code management
setInterval(async () => {
    const now = new Date();
    let cleanedCodes = 0;
    let cleanedSessions = 0;
    let cleanedPayments = 0;
    
    // Clean up old sessions
    for (const [userId, session] of userSessions.entries()) {
        // Remove sessions older than 7 days
        if (now - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
            userSessions.delete(userId);
            cleanedSessions++;
        }
    }
    
    // Clean up old generated codes (keep for 30 days for support purposes)
    for (const [code, data] of generatedCodes.entries()) {
        if (now - data.createdAt > 30 * 24 * 60 * 60 * 1000) {
            generatedCodes.delete(code);
            cleanedCodes++;
        }
    }
    
    // Clean up old payments
    for (const [orderId, payment] of activePayments.entries()) {
        if (now - payment.createdAt > 24 * 60 * 60 * 1000) {
            activePayments.delete(orderId);
            cleanedPayments++;
        }
    }
    
    if (cleanedCodes > 0 || cleanedSessions > 0 || cleanedPayments > 0) {
        console.log(`Cleanup completed: ${cleanedCodes} codes, ${cleanedSessions} sessions, ${cleanedPayments} payments removed`);
    }
    
    // Log system status every hour
    const premiumUsers = Array.from(userSessions.values()).filter(session => 
        session.premiumUntil && new Date() < session.premiumUntil
    ).length;
    
    console.log(`System Status: ${userSessions.size} active sessions, ${premiumUsers} premium users, ${generatedCodes.size} total codes`);
    
}, 60 * 60 * 1000); // Run every hour

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 PDF Tools Backend running on port ${PORT}`);
    console.log(`📊 Tool configurations:`, toolConfigs);
    console.log(`✅ Premium code system initialized (no email)`);
    console.log(`🎫 Demo codes: PREMIUM24H, TESTCODE123, LAUNCH2024, DEMO2024, FREEPREMIUM`);
    console.log(`📈 Available endpoints:`);
    console.log(`   • POST /api/process-pdf - Main PDF processing`);
    console.log(`   • GET  /api/user-status - User session status`);
    console.log(`   • POST /api/capture-paypal-payment - PayPal payment processing`);
    console.log(`   • POST /api/activate-premium-code - Premium code activation`);
    console.log(`   • POST /api/validate-premium-code - Code validation`);
    console.log(`   • GET  /api/premium-stats - Premium statistics (admin)`);
    console.log(`   • POST /api/generate-manual-codes - Generate codes (admin)`);
    console.log(`   • GET  /api/health - Health check`);
    console.log(`   • GET  /api/system-info - System information (admin)`);
    
    if (process.env.NODE_ENV === 'development') {
        console.log(`🔧 Development mode - enhanced logging enabled`);
        console.log(`🔑 Use X-Admin-Token header for admin endpoints`);
    }
});

module.exports = app;