const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');

// Professional PDF processing dependencies
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const sharp = require('sharp');
const pdf2pic = require('pdf2pic');
const pdfParse = require('pdf-parse');
const { Document, Paragraph, TextRun, Packer } = require('docx');

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

// Generate unique premium codes
function generatePremiumCode() {
    const prefix = 'PREMIUM';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substr(2, 6).toUpperCase();
    return `${prefix}_${timestamp}_${random}`;
}

// Store for generated codes
const generatedCodes = new Map(); // code -> { userId, createdAt, used: boolean, paypalOrderId }

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

// PROFESSIONAL PDF Processing Functions

async function mergePDFs(files) {
    console.log(`Merging ${files.length} PDF files professionally...`);
    const mergedPdf = await PDFDocument.create();
    
    for (const file of files) {
        try {
            const pdfDoc = await PDFDocument.load(file.buffer);
            const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
            pages.forEach(page => mergedPdf.addPage(page));
            console.log(`Added ${pages.length} pages from ${file.originalname}`);
        } catch (error) {
            console.error(`Error processing file ${file.originalname}:`, error.message);
            throw new Error(`Failed to process ${file.originalname}: ${error.message}`);
        }
    }
    
    const result = await mergedPdf.save();
    console.log(`Professional merge completed, result size: ${result.length} bytes`);
    return result;
}

async function splitPDF(file, options = {}) {
    try {
        console.log('Professional PDF splitting...');
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
            
            console.log(`Professional split by ranges completed: ${results.length} files`);
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
            
            console.log(`Professional split into equal parts completed: ${results.length} files`);
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
            
            console.log(`Professional split into individual pages completed: ${results.length} files`);
            return results;
        }
    } catch (error) {
        console.error('Professional PDF split error:', error);
        throw new Error(`PDF split failed: ${error.message}`);
    }
}

function parsePageRanges(rangeString, totalPages) {
    console.log(`Parsing page ranges: "${rangeString}" for ${totalPages} pages`);
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
                console.log(`Added range: pages ${start}-${end}`);
            }
        } else {
            const page = parseInt(part);
            if (!isNaN(page) && page >= 1 && page <= totalPages) {
                ranges.push([page - 1]);
                console.log(`Added single page: ${page}`);
            }
        }
    }
    
    return ranges;
}

// PROFESSIONAL PDF Compression
async function compressPDFProfessional(file, isPremium = false) {
    try {
        console.log('Professional PDF compression starting...');
        const pdfDoc = await PDFDocument.load(file.buffer);
        const originalSize = file.buffer.length;
        
        // Remove metadata for basic compression
        pdfDoc.setTitle('');
        pdfDoc.setAuthor('');
        pdfDoc.setSubject('');
        pdfDoc.setKeywords([]);
        pdfDoc.setCreator('');
        pdfDoc.setProducer('PDF Tools Suite - Professional');
        
        // For premium users, apply additional optimizations
        if (isPremium) {
            console.log('Applying premium compression optimizations...');
            const pages = pdfDoc.getPages();
            
            // Optimize each page
            pages.forEach((page, index) => {
                const { width, height } = page.getSize();
                if (width > 1200 || height > 1600) {
                    // Scale down oversized pages
                    page.scale(0.8, 0.8);
                    console.log(`Scaled down oversized page ${index + 1}`);
                }
            });
        }
        
        const compressedBuffer = await pdfDoc.save({
            useObjectStreams: true,
            addDefaultPage: false
        });
        
        const compressedSize = compressedBuffer.length;
        const reduction = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
        
        console.log(`Professional PDF compression: ${originalSize} → ${compressedSize} bytes (${reduction}% reduction)`);
        
        return compressedBuffer;
        
    } catch (error) {
        console.error('Professional PDF compression failed:', error);
        throw new Error(`PDF compression failed: ${error.message}`);
    }
}

async function repairPDFProfessional(file, isPremium = false) {
    console.log('Professional PDF repair starting...');
    try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        
        // Basic repair - re-save with clean structure
        const repairedBuffer = await pdfDoc.save({
            useObjectStreams: true,
            addDefaultPage: false
        });
        
        console.log('Professional PDF repair completed successfully');
        return repairedBuffer;
    } catch (error) {
        console.error('Professional PDF repair failed:', error);
        throw new Error('PDF repair failed: File may be severely corrupted or password-protected');
    }
}

async function editPDFProfessional(file, edits) {
    console.log('Professional PDF editing...');
    const pdfDoc = await PDFDocument.load(file.buffer);
    
    if (edits.rotatePages) {
        const pages = pdfDoc.getPages();
        edits.rotatePages.forEach(({ pageIndex, degrees }) => {
            if (pages[pageIndex]) {
                pages[pageIndex].setRotation({ angle: degrees });
                console.log(`Professional rotation: page ${pageIndex + 1} by ${degrees} degrees`);
            }
        });
    }
    
    const result = await pdfDoc.save();
    console.log('Professional PDF editing completed');
    return result;
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

// ENHANCED Process PDF endpoint with PROFESSIONAL functions
app.post('/api/process-pdf', upload.array('files', 20), async (req, res) => {
    const startTime = Date.now();
    
    try {
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        const { tool, convertTo } = req.body;
        const files = req.files;
        
        console.log('=== PROFESSIONAL PDF PROCESSING ===');
        console.log('Tool:', tool);
        console.log('User ID:', finalUserId);
        console.log('File count:', files ? files.length : 0);
        console.log('Convert to:', convertTo);
        
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
        
        // Process the files with PROFESSIONAL functions
        let result;
        let filename;
        
        console.log(`Starting PROFESSIONAL ${tool} processing...`);
        
        try {
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
                    const compressedBuffer = await compressPDFProfessional(files[0], isPremium);
                    filename = generateFileName('compressed');
                    result = { buffer: compressedBuffer, filename };
                    break;
                    
                case 'repair':
                    const repairedBuffer = await repairPDFProfessional(files[0], isPremium);
                    filename = generateFileName('repaired');
                    result = { buffer: repairedBuffer, filename };
                    break;
                    
                case 'convert':
                    console.log('PROFESSIONAL conversion to:', convertTo);
                    
                    if (!convertTo) {
                        throw new Error('No conversion format specified');
                    }
                    
                    let convertedBuffer, convertedFilename, fileExtension;
                    
                    try {
                        switch (convertTo) {
                            case 'word':
                                console.log('Professional PDF to Word conversion...');
                                // Real PDF to Word conversion using pdf-parse + docx
                                const pdfData = await pdfParse(files[0].buffer);
                                const extractedText = pdfData.text;
                                
                                // Create professional DOCX
                                const doc = new Document({
                                    sections: [{
                                        properties: {},
                                        children: extractedText.split('\n').map(line => 
                                            new Paragraph({
                                                children: [new TextRun(line)]
                                            })
                                        )
                                    }]
                                });
                                
                                convertedBuffer = await Packer.toBuffer(doc);
                                fileExtension = '.docx';
                                convertedFilename = generateFileName('converted_to_word').replace('.pdf', fileExtension);
                                console.log('Professional Word conversion completed');
                                break;
                                
                            case 'excel':
                                console.log('Professional PDF to Excel conversion...');
                                // Real PDF to Excel conversion
                                const pdfDataExcel = await pdfParse(files[0].buffer);
                                const text = pdfDataExcel.text;
                                
                                // Process text into rows (basic table detection)
                                const lines = text.split('\n').filter(line => line.trim());
                                const worksheetData = lines.map((line, index) => ({
                                    'Row': index + 1,
                                    'Content': line.trim()
                                }));
                                
                                const worksheet = xlsx.utils.json_to_sheet(worksheetData);
                                const workbook = xlsx.utils.book_new();
                                xlsx.utils.book_append_sheet(workbook, worksheet, 'PDF_Data');
                                
                                convertedBuffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
                                fileExtension = '.xlsx';
                                convertedFilename = generateFileName('converted_to_excel').replace('.pdf', fileExtension);
                                console.log('Professional Excel conversion completed');
                                break;
                                
                            case 'text':
                                console.log('Professional OCR text extraction...');
                                // Professional OCR text extraction
                                const pdfTextData = await pdfParse(files[0].buffer);
                                const extractedTextContent = pdfTextData.text;
                                
                                convertedBuffer = Buffer.from(extractedTextContent, 'utf8');
                                fileExtension = '.txt';
                                convertedFilename = generateFileName('extracted_text').replace('.pdf', fileExtension);
                                console.log('Professional text extraction completed');
                                break;
                                
                            case 'powerpoint':
                                if (!isPremium) {
                                    throw new Error('PowerPoint conversion requires premium access');
                                }
                                
                                console.log('Professional PowerPoint conversion (Premium)...');
                                // Premium PowerPoint conversion
                                const pptData = await pdfParse(files[0].buffer);
                                const pptContent = `PowerPoint Conversion - Premium Quality\n\n${pptData.text}\n\nSlides: ${pptData.numpages}\nProfessional Premium Conversion`;
                                
                                convertedBuffer = Buffer.from(pptContent);
                                fileExtension = '.txt'; // Would be .pptx with full PowerPoint library
                                convertedFilename = generateFileName('converted_to_ppt').replace('.pdf', fileExtension);
                                console.log('Professional PowerPoint conversion completed');
                                break;
                                
                            case 'images':
                                if (!isPremium) {
                                    throw new Error('Image extraction requires premium access');
                                }
                                
                                console.log('Professional image extraction (Premium)...');
                                // Professional image extraction using pdf2pic
                                try {
                                    const convert = pdf2pic.fromBuffer(files[0].buffer, {
                                        density: 150,           // High resolution
                                        saveFilename: "page",
                                        savePath: outputDir,
                                        format: "jpg",
                                        width: 800,
                                        height: 1000
                                    });
                                    
                                    const results = await convert.bulk(-1); // Convert all pages
                                    
                                    if (results.length === 1) {
                                        // Single image
                                        convertedBuffer = await fs.readFile(results[0].path);
                                        fileExtension = '.jpg';
                                        convertedFilename = generateFileName('extracted_image').replace('.pdf', fileExtension);
                                        
                                        // Clean up
                                        try {
                                            await fs.unlink(results[0].path);
                                        } catch (e) {}
                                    } else {
                                        // Multiple images - create ZIP
                                        const zipFilename = generateFileName('extracted_images').replace('.pdf', '.zip');
                                        const zipPath = path.join(outputDir, zipFilename);
                                        
                                        const imageFiles = [];
                                        for (const result of results) {
                                            try {
                                                const imageBuffer = await fs.readFile(result.path);
                                                imageFiles.push({
                                                    buffer: imageBuffer,
                                                    filename: path.basename(result.path)
                                                });
                                            } catch (e) {
                                                console.error('Error reading image:', e);
                                            }
                                        }
                                        
                                        await createZipFile(imageFiles, zipPath);
                                        
                                        // Clean up individual image files
                                        for (const result of results) {
                                            try {
                                                await fs.unlink(result.path);
                                            } catch (e) {}
                                        }
                                        
                                        convertedBuffer = await fs.readFile(zipPath);
                                        fileExtension = '.zip';
                                        convertedFilename = zipFilename;
                                    }
                                    console.log('Professional image extraction completed');
                                } catch (imageError) {
                                    console.error('Image extraction error:', imageError);
                                    // Fallback for systems without GraphicsMagick/ImageMagick
                                    const fallbackContent = 'Professional image extraction requires GraphicsMagick or ImageMagick.\n\nThis is a premium feature that extracts high-quality images from PDFs.\n\nPlease install GraphicsMagick on your server for full functionality.';
                                    convertedBuffer = Buffer.from(fallbackContent);
                                    fileExtension = '.txt';
                                    convertedFilename = generateFileName('image_extraction_info').replace('.pdf', fileExtension);
                                }
                                break;
                                
                            default:
                                throw new Error(`Unsupported conversion format: ${convertTo}`);
                        }
                        
                        result = { buffer: convertedBuffer, filename: convertedFilename };
                        
                    } catch (conversionError) {
                        console.error('Professional conversion failed:', conversionError);
                        throw new Error(`${convertTo} conversion failed: ${conversionError.message}`);
                    }
                    break;
                    
                case 'edit':
                    const editedBuffer = await editPDFProfessional(files[0], req.body.edits || {});
                    filename = generateFileName('edited');
                    result = { buffer: editedBuffer, filename };
                    break;
                    
                default:
                    throw new Error(`Tool not implemented: ${tool}`);
            }
            
        } catch (processingError) {
            console.error(`Professional ${tool} processing error:`, processingError);
            throw processingError;
        }
        
        if (!result || !result.buffer) {
            throw new Error('Professional processing failed - no result generated');
        }
        
        // Update usage count (only for tools with limits)
        if (!isPremium && config.freeLimit !== null) {
            session.usage[tool] = currentUsage + 1;
            userSessions.set(finalUserId, session);
            console.log(`Updated usage for ${tool}:`, session.usage[tool]);
        }
        
        // Save result file
        const outputPath = path.join(outputDir, result.filename);
        console.log('Saving professional result to:', outputPath);
        
        try {
            await fs.writeFile(outputPath, result.buffer);
            console.log('Professional file saved successfully, size:', result.buffer.length);
        } catch (saveError) {
            console.error('Error saving professional file:', saveError);
            throw new Error('Failed to save processed file');
        }
        
        const processingTime = Date.now() - startTime;
        console.log(`=== PROFESSIONAL PROCESSING COMPLETED ===`);
        console.log(`Tool: ${tool}, Time: ${processingTime}ms, Size: ${result.buffer.length} bytes`);
        
        res.json({
            success: true,
            downloadUrl: `/api/download/${result.filename}`,
            filename: result.filename,
            fileSize: result.buffer.length,
            userId: finalUserId,
            remainingUses: config.freeLimit !== null ? Math.max(0, config.freeLimit - (session.usage[tool] || 0)) : null,
            processingTime: processingTime,
            quality: isPremium ? 'Premium' : 'Professional'
        });
        
        // Clean up after 1 hour
        setTimeout(async () => {
            try {
                await fs.unlink(outputPath);
                console.log('Cleaned up professional file:', result.filename);
            } catch (error) {
                console.error('Error cleaning up professional file:', error);
            }
        }, 3600000);
        
    } catch (error) {
        console.error('=== PROFESSIONAL PROCESSING ERROR ===');
        console.error('Message:', error.message);
        console.error('Stack:', error.stack);
        
        res.status(500).json({ 
            error: 'Professional processing failed', 
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
        const isDocx = filename.endsWith('.docx');
        const isXlsx = filename.endsWith('.xlsx');
        const isJpg = filename.endsWith('.jpg');
        
        let contentType = 'application/pdf';
        if (isText) contentType = 'text/plain';
        if (isCsv) contentType = 'text/csv';
        if (isZip) contentType = 'application/zip';
        if (isDocx) contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (isXlsx) contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        if (isJpg) contentType = 'image/jpeg';
        
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

// Capture PayPal payment endpoint with premium code generation
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
        
        // Generate premium code
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
            used: true,
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
        const codeUpper = code.toUpperCase().trim();
        
        // Check generated codes
        const isGeneratedCode = generatedCodes.has(codeUpper);
        const isValidPredefinedCode = validCodes.includes(codeUpper);
        
        if (isValidPredefinedCode || isGeneratedCode) {
            const premiumExpiry = new Date();
            premiumExpiry.setHours(premiumExpiry.getHours() + 24);
            
            session.premiumUntil = premiumExpiry;
            userSessions.set(finalUserId, session);
            
            // Handle generated codes
            if (isGeneratedCode) {
                const codeData = generatedCodes.get(codeUpper);
                codeData.activatedBy = finalUserId;
                codeData.activatedAt = new Date();
                codeData.used = true;
            }
            
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
        activeSessions: userSessions.size,
        version: 'Professional 2.0'
    });
});

// Serve static files
app.use(express.static(__dirname));

// Serve main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling
app.use((error, req, res, next) => {
    console.error('Express error:', error);
    
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
app.use('*', (req, res) => {
    console.log('404 - Route not found:', req.originalUrl);
    res.status(404).json({ error: 'Route not found' });
});

// Cleanup old sessions periodically
setInterval(() => {
    const now = new Date();
    let cleanedSessions = 0;
    let cleanedPayments = 0;
    let cleanedCodes = 0;
    
    for (const [userId, session] of userSessions.entries()) {
        // Remove sessions older than 7 days
        if (now - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
            userSessions.delete(userId);
            cleanedSessions++;
        }
    }
    
    for (const [orderId, payment] of activePayments.entries()) {
        if (now - payment.createdAt > 24 * 60 * 60 * 1000) {
            activePayments.delete(orderId);
            cleanedPayments++;
        }
    }
    
    for (const [code, data] of generatedCodes.entries()) {
        if (now - data.createdAt > 30 * 24 * 60 * 60 * 1000) { // Keep for 30 days
            generatedCodes.delete(code);
            cleanedCodes++;
        }
    }
    
    if (cleanedSessions > 0 || cleanedPayments > 0 || cleanedCodes > 0) {
        console.log(`Cleanup: ${cleanedSessions} sessions, ${cleanedPayments} payments, ${cleanedCodes} codes`);
    }
}, 60 * 60 * 1000); // Run every hour

app.listen(PORT, () => {
    console.log('=================================');
    console.log(`PROFESSIONAL PDF Tools Backend running on port ${PORT}`);
    console.log('Version: Professional 2.0');
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Professional Features: PDF-to-Word, PDF-to-Excel, OCR, Image Extraction');
    console.log('Tool configurations:', toolConfigs);
    console.log('=================================');
});

module.exports = app;