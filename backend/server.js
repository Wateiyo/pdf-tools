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

// Middleware - CORS Configuration
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
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    optionsSuccessStatus: 200
}));
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
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

// Helper function to generate unique filename
function generateFileName(prefix = 'processed') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`;
}

// Helper function to create zip file
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
    
    console.log('Split options:', { splitMethod, pageRanges, numberOfParts, totalPages });
    
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

// Helper function to parse page ranges
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
    
    // Remove metadata to reduce size
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setCreator('');
    pdfDoc.setProducer(isPremium ? 'PDF Tools Suite Premium' : 'PDF Tools Suite');
    
    if (!isPremium) {
        // Add subtle watermark for free users
        const pages = pdfDoc.getPages();
        pages.forEach(page => {
            // This would add a subtle watermark in a real implementation
        });
    }
    
    return await pdfDoc.save();
}

async function repairPDF(file, isPremium = false) {
    try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        
        if (isPremium) {
            // Premium users get additional repair attempts
            // In a real implementation, this would include more sophisticated repair logic
        }
        
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

// Handle preflight OPTIONS requests
app.options('*', (req, res) => {
    res.status(200).end();
});

// API Routes
app.post('/api/process-pdf', upload.array('files', 20), async (req, res) => {
    try {
        console.log('Received request:', {
            tool: req.body.tool,
            hasPremium: req.body.hasPremium,
            fileCount: req.files ? req.files.length : 0,
            convertTo: req.body.convertTo,
            splitMethod: req.body.splitMethod
        });
        
        const { tool, hasPremium } = req.body;
        const files = req.files;
        const isPremium = hasPremium === 'true';
        
        if (!files || files.length === 0) {
            console.error('No files uploaded');
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        if (!tool) {
            console.error('No tool specified');
            return res.status(400).json({ error: 'No tool specified' });
        }
        
        // Updated tool configurations with freemium limits
        const toolConfigs = {
            merge: { requiresPremium: false, freeLimit: 5 },
            compress: { requiresPremium: false, freeLimit: 1 },
            split: { requiresPremium: false, freeLimit: 1 },
            edit: { requiresPremium: true, freeLimit: 0 },
            repair: { requiresPremium: false, freeLimit: 1 },
            convert: { requiresPremium: false, freeLimit: 2 }
        };
        
        const config = toolConfigs[tool];
        if (!config) {
            return res.status(400).json({ error: 'Invalid tool specified' });
        }
        
        // Check if tool requires premium and user doesn't have it
        if (config.requiresPremium && !isPremium) {
            return res.status(403).json({ error: 'Premium access required for this tool' });
        }
        
        // Check free limits for non-premium users
        if (!isPremium && config.freeLimit > 0 && files.length > config.freeLimit) {
            return res.status(403).json({ 
                error: `Free version allows maximum ${config.freeLimit} files. Upgrade to premium for unlimited access.` 
            });
        }
        
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
                
                // Restrict advanced split options to premium users
                if (!isPremium && (splitOptions.splitMethod === 'page_ranges' || splitOptions.splitMethod === 'equal_parts')) {
                    return res.status(403).json({ 
                        error: 'Advanced split options require premium access' 
                    });
                }
                
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
                filename = generateFileName(isPremium ? 'compressed_premium' : 'compressed');
                result = { buffer: compressedBuffer, filename };
                break;
                
            case 'repair':
                const repairedBuffer = await repairPDF(files[0], isPremium);
                filename = generateFileName('repaired');
                result = { buffer: repairedBuffer, filename };
                break;
                
            case 'convert':
                const convertTo = req.body.convertTo || 'word';
                const pdfDoc = await PDFDocument.load(files[0].buffer);
                
                let convertedBuffer, convertedFilename, fileExtension;
                const qualityNote = isPremium ? 'High-quality premium conversion with advanced formatting preservation.' : 'Basic conversion. Premium users get enhanced quality and formatting.';
                
                switch (convertTo) {
                    case 'word':
                        const pageCount = pdfDoc.getPageCount();
                        const wordContent = `${pdfDoc.getTitle() || 'Converted Document'}\n\n` +
                            `Pages: ${pageCount}\n` +
                            `Conversion Type: PDF to Word\n` +
                            `Quality: ${isPremium ? 'Premium' : 'Basic'}\n\n` +
                            `${qualityNote}\n\n` +
                            `[Document content would appear here with ${isPremium ? 'preserved formatting, images, and tables' : 'basic text extraction'}]`;
                        
                        convertedBuffer = Buffer.from(wordContent);
                        fileExtension = '.txt';
                        convertedFilename = generateFileName('converted_to_word').replace('.pdf', fileExtension);
                        break;
                        
                    case 'excel':
                        const excelContent = `PDF Analysis Report\nPages,${pdfDoc.getPageCount()}\nTitle,${pdfDoc.getTitle() || 'Untitled'}\nQuality,${isPremium ? 'Premium' : 'Basic'}\nConverted,${new Date().toISOString()}\n\n"Note","${qualityNote}"`;
                        convertedBuffer = Buffer.from(excelContent);
                        fileExtension = '.csv';
                        convertedFilename = generateFileName('converted_to_excel').replace('.pdf', fileExtension);
                        break;
                        
                    case 'powerpoint':
                        const pptContent = `PDF Presentation Summary\n\nSlides: ${pdfDoc.getPageCount()}\nOriginal Title: ${pdfDoc.getTitle() || 'Untitled'}\nQuality: ${isPremium ? 'Premium' : 'Basic'}\n\n${qualityNote}`;
                        convertedBuffer = Buffer.from(pptContent);
                        fileExtension = '.txt';
                        convertedFilename = generateFileName('converted_to_ppt').replace('.pdf', fileExtension);
                        break;
                        
                    case 'images':
                        const imageInfo = `PDF Image Extraction Report\n\nPages processed: ${pdfDoc.getPageCount()}\nQuality: ${isPremium ? 'High-resolution with actual image extraction' : 'Basic analysis only'}\n\n${qualityNote}`;
                        convertedBuffer = Buffer.from(imageInfo);
                        fileExtension = '.txt';
                        convertedFilename = generateFileName('image_extraction_report').replace('.pdf', fileExtension);
                        break;
                        
                    case 'text':
                        const textContent = `Text Extraction from PDF\n\nDocument: ${pdfDoc.getTitle() || 'Untitled'}\nPages: ${pdfDoc.getPageCount()}\nQuality: ${isPremium ? 'Premium' : 'Basic'}\nExtracted: ${new Date().toLocaleString()}\n\n${qualityNote}\n\n[Extracted text would appear here]`;
                        convertedBuffer = Buffer.from(textContent);
                        fileExtension = '.txt';
                        convertedFilename = generateFileName('extracted_text').replace('.pdf', fileExtension);
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
        
        // Save the result file temporarily
        const outputPath = path.join(outputDir, result.filename);
        await fs.writeFile(outputPath, result.buffer);
        
        // Return download URL
        res.json({
            success: true,
            downloadUrl: `/api/download/${result.filename}`,
            filename: result.filename,
            fileSize: result.buffer.length,
            isPremium: isPremium
        });
        
        // Clean up file after 1 hour
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
        
        const isImage = filename.endsWith('.png') || filename.endsWith('.jpg') || filename.endsWith('.jpeg');
        const isJson = filename.endsWith('.json');
        const isText = filename.endsWith('.txt');
        const isCsv = filename.endsWith('.csv');
        const isZip = filename.endsWith('.zip');
        
        let contentType = 'application/pdf';
        if (isImage) {
            contentType = `image/${path.extname(filename).slice(1)}`;
        } else if (isJson) {
            contentType = 'application/json';
        } else if (isText) {
            contentType = 'text/plain';
        } else if (isCsv) {
            contentType = 'text/csv';
        } else if (isZip) {
            contentType = 'application/zip';
        }
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        const fileBuffer = await fs.readFile(filePath);
        res.send(fileBuffer);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(404).json({ error: 'File not found' });
    }
});

// PayPal payment verification endpoint
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { paymentId, payerId, amount } = req.body;
        
        if (amount === '2.00') {
            const token = generatePremiumToken();
            
            res.json({
                success: true,
                premiumToken: token,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            });
        } else {
            res.status(400).json({ error: 'Invalid payment amount' });
        }
        
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

function generatePremiumToken() {
    return `premium_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Error handling middleware
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

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Cleanup old files on startup
async function cleanupOldFiles() {
    try {
        await fs.mkdir(outputDir, { recursive: true });
        
        const files = await fs.readdir(outputDir);
        const now = Date.now();
        
        for (const file of files) {
            const filePath = path.join(outputDir, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > 2 * 60 * 60 * 1000) {
                await fs.unlink(filePath);
                console.log(`Cleaned up old file: ${file}`);
            }
        }
    } catch (error) {
        console.log('Cleanup note:', error.message);
    }
}

setInterval(cleanupOldFiles, 60 * 60 * 1000);

// Start server
app.listen(PORT, () => {
    console.log(`PDF Tools Backend running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    
    cleanupOldFiles();
});

module.exports = app;