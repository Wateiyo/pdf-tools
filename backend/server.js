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

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
        files: 20 // Maximum 20 files
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'), false);
        }
    }
});

// Ensure uploads directory exists
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

async function splitPDF(file, pageRanges = []) {
    const pdfDoc = await PDFDocument.load(file.buffer);
    const totalPages = pdfDoc.getPageCount();
    
    if (pageRanges.length === 0) {
        // Split into individual pages if no ranges specified
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
    } else {
        // Split based on specified ranges
        const results = [];
        
        for (const range of pageRanges) {
            const newPdf = await PDFDocument.create();
            const pages = await newPdf.copyPages(pdfDoc, range);
            pages.forEach(page => newPdf.addPage(page));
            
            results.push({
                buffer: await newPdf.save(),
                filename: `pages_${range.join('-')}.pdf`
            });
        }
        
        return results;
    }
}

async function compressPDF(file) {
    // Basic PDF compression using pdf-lib
    const pdfDoc = await PDFDocument.load(file.buffer);
    
    // Remove metadata to reduce size
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setCreator('');
    pdfDoc.setProducer('PDF Tools Suite');
    
    return await pdfDoc.save();
}

async function repairPDF(file) {
    try {
        // Attempt to load and re-save the PDF to fix basic issues
        const pdfDoc = await PDFDocument.load(file.buffer);
        return await pdfDoc.save();
    } catch (error) {
        throw new Error('PDF repair failed: File may be severely corrupted');
    }
}

async function convertPDFToImages(file, format = 'png') {
    // Simplified PDF to image conversion using canvas
    // This is a basic implementation - for production, you might want a more robust solution
    try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        const pages = pdfDoc.getPages();
        
        // For now, return a placeholder response
        // In a full implementation, you'd use a library like pdf-poppler or similar
        const results = pages.map((page, index) => ({
            path: path.join(outputDir, `page_${index + 1}.${format}`),
            name: `page_${index + 1}.${format}`
        }));
        
        return results;
    } catch (error) {
        throw new Error('PDF to image conversion failed: ' + error.message);
    }
}

// API Routes

app.post('/api/process-pdf', upload.array('files', 20), async (req, res) => {
    try {
        console.log('Received request:', {
            tool: req.body.tool,
            hasPremium: req.body.hasPremium,
            fileCount: req.files ? req.files.length : 0,
            convertTo: req.body.convertTo
        });
        
        const { tool, hasPremium } = req.body;
        const files = req.files;
        
        if (!files || files.length === 0) {
            console.error('No files uploaded');
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        if (!tool) {
            console.error('No tool specified');
            return res.status(400).json({ error: 'No tool specified' });
        }
        
        // Check premium requirements
        const toolConfigs = {
            merge: { requiresPremium: false, freeLimit: 3 },
            compress: { requiresPremium: true, freeLimit: 0 },
            split: { requiresPremium: false, freeLimit: 5 },
            edit: { requiresPremium: true, freeLimit: 0 },
            repair: { requiresPremium: true, freeLimit: 0 },
            convert: { requiresPremium: false, freeLimit: 1 }
        };
        
        const config = toolConfigs[tool];
        if (!config) {
            return res.status(400).json({ error: 'Invalid tool specified' });
        }
        
        if (config.requiresPremium && hasPremium !== 'true') {
            return res.status(403).json({ error: 'Premium access required' });
        }
        
        if (hasPremium !== 'true' && files.length > config.freeLimit && config.freeLimit > 0) {
            return res.status(403).json({ error: `Free version allows maximum ${config.freeLimit} files` });
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
                const splitResults = await splitPDF(files[0]);
                if (splitResults.length === 1) {
                    result = splitResults[0];
                } else {
                    // For multiple results, create a zip file
                    // This would require additional zip library implementation
                    result = splitResults[0]; // Return first page for now
                }
                break;
                
            case 'compress':
                const compressedBuffer = await compressPDF(files[0]);
                filename = generateFileName('compressed');
                result = { buffer: compressedBuffer, filename };
                break;
                
            case 'repair':
                const repairedBuffer = await repairPDF(files[0]);
                filename = generateFileName('repaired');
                result = { buffer: repairedBuffer, filename };
                break;
                
            case 'convert':
                const convertTo = req.body.convertTo || 'word';
                const pdfDoc = await PDFDocument.load(files[0].buffer);
                
                let convertedBuffer, convertedFilename, fileExtension;
                
                switch (convertTo) {
                    case 'word':
                        // For now, extract text content and create a basic document
                        const pageCount = pdfDoc.getPageCount();
                        const pdfInfo = {
                            title: pdfDoc.getTitle() || 'Converted Document',
                            pages: pageCount,
                            extractedText: `This PDF has been processed and contains ${pageCount} pages.\n\nNote: This is a basic conversion. Premium users get full text extraction and formatting preservation.`,
                            conversionType: 'PDF to Word',
                            timestamp: new Date().toISOString()
                        };
                        
                        // Create a simple text representation (in production, you'd use a proper PDF-to-Word library)
                        const wordContent = `${pdfInfo.title}\n\n${pdfInfo.extractedText}`;
                        convertedBuffer = Buffer.from(wordContent);
                        fileExtension = '.txt'; // Simplified for now
                        convertedFilename = generateFileName('converted_to_word').replace('.pdf', fileExtension);
                        break;
                        
                    case 'excel':
                        const excelContent = `PDF Analysis Report\nPages,${pdfDoc.getPageCount()}\nTitle,${pdfDoc.getTitle() || 'Untitled'}\nConverted,${new Date().toISOString()}`;
                        convertedBuffer = Buffer.from(excelContent);
                        fileExtension = '.csv';
                        convertedFilename = generateFileName('converted_to_excel').replace('.pdf', fileExtension);
                        break;
                        
                    case 'powerpoint':
                        const pptContent = `PDF Presentation Summary\n\nSlides: ${pdfDoc.getPageCount()}\nOriginal Title: ${pdfDoc.getTitle() || 'Untitled'}\n\nNote: Each PDF page represents a potential slide.`;
                        convertedBuffer = Buffer.from(pptContent);
                        fileExtension = '.txt';
                        convertedFilename = generateFileName('converted_to_ppt').replace('.pdf', fileExtension);
                        break;
                        
                    case 'images':
                        // Basic image info (in production, you'd extract actual images)
                        const imageInfo = `PDF Image Extraction Report\n\nPages processed: ${pdfDoc.getPageCount()}\nPotential images per page: Varies\n\nNote: Premium users get actual image extraction in PNG/JPG format.`;
                        convertedBuffer = Buffer.from(imageInfo);
                        fileExtension = '.txt';
                        convertedFilename = generateFileName('image_extraction_report').replace('.pdf', fileExtension);
                        break;
                        
                    case 'text':
                        const textContent = `Text Extraction from PDF\n\nDocument: ${pdfDoc.getTitle() || 'Untitled'}\nPages: ${pdfDoc.getPageCount()}\nExtracted: ${new Date().toLocaleString()}\n\n[Text content would appear here in full version]`;
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
                // Basic edit functionality - this would be expanded based on requirements
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
            fileSize: result.buffer.length
        });
        
        // Clean up file after 1 hour
        setTimeout(async () => {
            try {
                await fs.unlink(outputPath);
            } catch (error) {
                console.error('Error cleaning up file:', error);
            }
        }, 3600000); // 1 hour
        
    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).json({ 
            error: 'Processing failed', 
            details: error.message 
        });
    }
});

// Basic PDF editing function
async function editPDF(file, edits) {
    const pdfDoc = await PDFDocument.load(file.buffer);
    
    // Basic rotation functionality
    if (edits.rotatePages) {
        const pages = pdfDoc.getPages();
        edits.rotatePages.forEach(({ pageIndex, degrees }) => {
            if (pages[pageIndex]) {
                pages[pageIndex].setRotation({ angle: degrees });
            }
        });
    }
    
    // Add text functionality would require additional libraries like pdf-lib text features
    // This is a basic implementation
    
    return await pdfDoc.save();
}

// Download endpoint
app.get('/api/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(outputDir, filename);
        
        // Check if file exists
        await fs.access(filePath);
        
        // Set appropriate headers
        const isImage = filename.endsWith('.png') || filename.endsWith('.jpg') || filename.endsWith('.jpeg');
        const isJson = filename.endsWith('.json');
        const isText = filename.endsWith('.txt');
        const isCsv = filename.endsWith('.csv');
        
        let contentType = 'application/pdf';
        if (isImage) {
            contentType = `image/${path.extname(filename).slice(1)}`;
        } else if (isJson) {
            contentType = 'application/json';
        } else if (isText) {
            contentType = 'text/plain';
        } else if (isCsv) {
            contentType = 'text/csv';
        }
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        // Stream the file
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
        
        // Here you would verify the payment with PayPal's API
        // This is a placeholder implementation
        
        if (amount === '2.00') {
            // Generate a premium access token (in production, use proper JWT)
            const token = generatePremiumToken();
            
            res.json({
                success: true,
                premiumToken: token,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
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
        // Ensure output directory exists
        await fs.mkdir(outputDir, { recursive: true });
        
        const files = await fs.readdir(outputDir);
        const now = Date.now();
        
        for (const file of files) {
            const filePath = path.join(outputDir, file);
            const stats = await fs.stat(filePath);
            
            // Delete files older than 2 hours
            if (now - stats.mtime.getTime() > 2 * 60 * 60 * 1000) {
                await fs.unlink(filePath);
                console.log(`Cleaned up old file: ${file}`);
            }
        }
    } catch (error) {
        // Ignore cleanup errors - they're not critical
        console.log('Cleanup note:', error.message);
    }
}

// Run cleanup every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);

// Start server
app.listen(PORT, () => {
    console.log(`PDF Tools Backend running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Run initial cleanup
    cleanupOldFiles();
});

module.exports = app;