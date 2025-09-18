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

// Generate unique user ID
function generateUserId() {
    return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
    const pdfDoc = await PDFDocument.load(file.buffer);
    const totalPages = pdfDoc.getPageCount();
    const { splitMethod, pageRanges, numberOfParts } = options;
    
    if (splitMethod === 'page_ranges' && pageRanges) {
        const ranges = parsePageRanges(pageRanges, totalPages);
        const results = [];
        
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            const newPdf = await PDFDocument.create();
            const pages = await newPdf.copyPages(pdfDoc, range);
            pages.forEach(page => newPdf.addPage(page));
            
            const rangeStr = range.length === 1 ? `page_${range[0] + 1}` : `pages_${range[0] + 1}-${range[range.length - 1] + 1}`;
            results.push({
                buffer: await newPdf.save(),
                filename: `${rangeStr}.pdf`
            });
        }
        
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
                
                results.push({
                    buffer: await newPdf.save(),
                    filename: `part_${i + 1}_pages_${startPage + 1}-${endPage + 1}.pdf`
                });
            }
        }
        
        return results;
    } else {
        // Default: Split into individual pages
        const results = [];
        
        for (let i = 0; i < totalPages; i++) {
            const newPdf = await PDFDocument.create();
            const [page] = await newPdf.copyPages(pdfDoc, [i]);
            newPdf.addPage(page);
            
            results.push({
                buffer: await newPdf.save(),
                filename: `page_${i + 1}.pdf`
            });
        }
        
        return results;
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
            convertTo
        });
        
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        if (!tool) {
            return res.status(400).json({ error: 'No tool specified' });
        }
        
        const config = toolConfigs[tool];
        const isPremium = hasPremiumAccess(session);
        const currentUsage = session.usage[tool] || 0;
        
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
        
        switch (tool) {
            case 'merge':
                const mergedBuffer = await mergePDFs(files);
                filename = generateFileName('merged');
                result = { buffer: mergedBuffer, filename };
                break;
                
            case 'split':
                const splitOptions = {
                    splitMethod: req.body.splitMethod || 'all_pages',
                    pageRanges: req.body.pageRanges || '',
                    numberOfParts: req.body.numberOfParts || '2'
                };
                
                const splitResults = await splitPDF(files[0], splitOptions);
                
                if (splitResults.length === 1) {
                    result = splitResults[0];
                } else {
                    const zipFilename = generateFileName('split_pages').replace('.pdf', '.zip');
                    const zipPath = path.join(outputDir, zipFilename);
                    
                    await createZipFile(splitResults, zipPath);
                    
                    result = {
                        buffer: await fs.readFile(zipPath),
                        filename: zipFilename,
                        isZip: true
                    };
                }
                break;
                
            case 'compress':
                const compressedBuffer = await compressPDF(files[0], isPremium);
                filename = generateFileName('compressed');
                result = { buffer: compressedBuffer, filename };
                break;
                
            case 'repair':
                const repairedBuffer = await repairPDF(files[0], isPremium);
                filename = generateFileName('repaired');
                result = { buffer: repairedBuffer, filename };
                break;
                
            case 'convert':
                const pdfDoc = await PDFDocument.load(files[0].buffer);
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
                        throw new Error('Unsupported conversion format');
                }
                
                result = { buffer: convertedBuffer, filename: convertedFilename };
                break;
                
            case 'edit':
                const editedBuffer = await editPDF(files[0], req.body.edits || {});
                filename = generateFileName('edited');
                result = { buffer: editedBuffer, filename };
                break;
                
            default:
                throw new Error('Tool not implemented');
        }
        
        // Update usage count (only for tools with limits)
        if (!isPremium && config.freeLimit !== null) {
            session.usage[tool] = currentUsage + 1;
            userSessions.set(finalUserId, session);
        }
        
        // Save result file
        const outputPath = path.join(outputDir, result.filename);
        await fs.writeFile(outputPath, result.buffer);
        
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
            } catch (error) {
                console.error('Error cleaning up file:', error);
            }
        }, 3600000);
        
    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).json({ 
            error: 'Processing failed', 
            details: error.message 
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

// Capture PayPal payment endpoint
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
        
        // Grant premium access for 24 hours
        const premiumExpiry = new Date();
        premiumExpiry.setHours(premiumExpiry.getHours() + 24);
        
        session.premiumUntil = premiumExpiry;
        userSessions.set(finalUserId, session);
        
        console.log(`Premium access granted to user ${finalUserId} until ${premiumExpiry}`);
        
        res.json({
            success: true,
            premiumUntil: premiumExpiry.toISOString(),
            message: 'Payment successful! You now have 24-hour premium access.',
            orderId: orderId
        });
        
    } catch (error) {
        console.error('Payment capture error:', error);
        res.status(500).json({ error: 'Payment capture failed' });
    }
});

// Premium code activation endpoint
app.post('/api/activate-premium-code', async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        
        const validCodes = ['PREMIUM24H', 'TESTCODE123', 'LAUNCH2024', 'DEMO2024'];
        
        if (validCodes.includes(code.toUpperCase())) {
            const premiumExpiry = new Date();
            premiumExpiry.setHours(premiumExpiry.getHours() + 24);
            
            session.premiumUntil = premiumExpiry;
            userSessions.set(finalUserId, session);
            
            res.json({
                success: true,
                premiumUntil: premiumExpiry.toISOString(),
                userId: finalUserId,
                message: 'Premium code activated successfully!'
            });
        } else {
            res.status(400).json({ error: 'Invalid premium code' });
        }
        
    } catch (error) {
        console.error('Code activation error:', error);
        res.status(500).json({ error: 'Code activation failed' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: userSessions.size
    });
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

// Cleanup old sessions periodically
setInterval(() => {
    const now = new Date();
    for (const [userId, session] of userSessions.entries()) {
        // Remove sessions older than 7 days
        if (now - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
            userSessions.delete(userId);
        }
    }
    
    // Clean up old payments
    for (const [orderId, payment] of activePayments.entries()) {
        if (now - payment.createdAt > 24 * 60 * 60 * 1000) {
            activePayments.delete(orderId);
        }
    }
}, 60 * 60 * 1000); // Run every hour

app.listen(PORT, () => {
    console.log(`PDF Tools Backend running on port ${PORT}`);
    console.log('Tool configurations:', toolConfigs);
});

module.exports = app;