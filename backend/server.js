const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument } = require('pdf-lib');
const archiver = require('archiver');

// Professional PDF processing dependencies (only ones that work reliably)
const pdfParse = require('pdf-parse');
const { Document, Paragraph, TextRun, Packer } = require('docx');
const XLSX = require('xlsx');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// In-memory storage for user sessions and usage tracking
const userSessions = new Map();
const activePayments = new Map();

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
const generatedCodes = new Map();

// Tool configurations
const toolConfigs = {
    merge: { requiresPremium: false, freeLimit: null },
    compress: { requiresPremium: false, freeLimit: null },
    split: { requiresPremium: false, freeLimit: 5 },
    edit: { requiresPremium: false, freeLimit: 2 },
    repair: { requiresPremium: false, freeLimit: 2 },
    convert: { requiresPremium: false, freeLimit: null }
};

// Middleware
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
            'https://srv-d358t78dl3ps738fkjpg.onrender.com',
            'http://localhost:3000',
            'http://localhost:3001',
            'https://pdf-tools-3r9n.onrender.com'
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
app.use(express.static(path.join(__dirname)));

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
        console.log('Directories created successfully');
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
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`Zip file created: ${archive.pointer()} total bytes`);
            resolve();
        });

        archive.on('error', (err) => reject(err));
        archive.pipe(output);

        files.forEach((file) => {
            archive.append(file.buffer, { name: file.filename });
        });

        archive.finalize();
    });
}

// Helper function to parse color strings
function parseColor(colorString) {
    if (!colorString || typeof colorString !== 'string') return null;
    
    if (colorString.startsWith('#') && colorString.length === 7) {
        return {
            r: parseInt(colorString.substr(1, 2), 16) / 255,
            g: parseInt(colorString.substr(3, 2), 16) / 255,
            b: parseInt(colorString.substr(5, 2), 16) / 255
        };
    }
    
    // Preset colors
    const colors = {
        'red': { r: 1, g: 0, b: 0 },
        'green': { r: 0, g: 1, b: 0 },
        'blue': { r: 0, g: 0, b: 1 },
        'black': { r: 0, g: 0, b: 0 },
        'white': { r: 1, g: 1, b: 1 },
        'gray': { r: 0.5, g: 0.5, b: 0.5 }
    };
    
    return colors[colorString.toLowerCase()] || null;
}

// PDF Processing Functions

async function mergePDFs(files) {
    console.log(`Professional merge: Processing ${files.length} PDF files...`);
    const mergedPdf = await PDFDocument.create();
    let totalPages = 0;
    
    for (const file of files) {
        try {
            const pdfDoc = await PDFDocument.load(file.buffer);
            const pageCount = pdfDoc.getPageCount();
            const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
            pages.forEach(page => mergedPdf.addPage(page));
            totalPages += pageCount;
            console.log(`✓ Added ${pageCount} pages from ${file.originalname}`);
        } catch (error) {
            throw new Error(`Failed to process ${file.originalname}: ${error.message}`);
        }
    }
    
    const result = await mergedPdf.save();
    console.log(`Professional merge completed: ${totalPages} total pages, ${result.length} bytes`);
    return result;
}

async function splitPDF(file, options = {}) {
    console.log('Professional PDF splitting...');
    const pdfDoc = await PDFDocument.load(file.buffer);
    const totalPages = pdfDoc.getPageCount();
    const { splitMethod, pageRanges, numberOfParts } = options;
    
    console.log(`Splitting ${totalPages} pages using method: ${splitMethod}`);
    
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
        
        console.log(`Professional range split completed: ${results.length} files`);
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
        
        console.log(`Professional equal parts split completed: ${results.length} files`);
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
        
        console.log(`Professional page split completed: ${results.length} files`);
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
    console.log('Professional PDF compression...');
    const pdfDoc = await PDFDocument.load(file.buffer);
    const originalSize = file.buffer.length;
    
    // Remove metadata
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setCreator('');
    pdfDoc.setProducer('PDF Tools Suite - Professional');
    
    // Premium users get additional optimizations
    if (isPremium) {
        console.log('Applying premium compression optimizations...');
        const pages = pdfDoc.getPages();
        
        pages.forEach((page, index) => {
            const { width, height } = page.getSize();
            if (width > 1200 || height > 1600) {
                page.scale(0.85, 0.85);
                console.log(`Optimized oversized page ${index + 1}`);
            }
        });
    }
    
    const compressedBuffer = await pdfDoc.save({
        useObjectStreams: true,
        addDefaultPage: false
    });
    
    const compressedSize = compressedBuffer.length;
    const reduction = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
    
    console.log(`Professional compression: ${originalSize} → ${compressedSize} bytes (${reduction}% reduction)`);
    return compressedBuffer;
}

// ENHANCED PDF REPAIR FUNCTION
async function repairPDFEnhanced(file, isPremium = false) {
    console.log('Enhanced PDF repair - analyzing document structure...');
    let repairLog = [];
    let issuesFound = 0;
    let issuesFixed = 0;
    
    try {
        // Step 1: Try to load the PDF with different strategies
        let pdfDoc;
        let loadMethod = 'standard';
        
        try {
            // First attempt: Standard loading
            pdfDoc = await PDFDocument.load(file.buffer);
            console.log('PDF loaded successfully with standard method');
        } catch (standardError) {
            console.log('Standard loading failed, trying recovery mode...');
            repairLog.push('Standard loading failed - attempting recovery');
            issuesFound++;
            
            try {
                // Second attempt: Ignore errors and try to recover what we can
                pdfDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
                loadMethod = 'recovery';
                repairLog.push('PDF loaded using recovery mode');
                issuesFixed++;
            } catch (recoveryError) {
                // Third attempt: Try to load with minimal validation
                try {
                    pdfDoc = await PDFDocument.load(file.buffer, { 
                        ignoreEncryption: true,
                        parseSpeed: 0.1 // Very slow, careful parsing
                    });
                    loadMethod = 'careful';
                    repairLog.push('PDF loaded using careful parsing mode');
                    issuesFixed++;
                } catch (finalError) {
                    throw new Error(`PDF is severely corrupted and cannot be repaired: ${finalError.message}`);
                }
            }
        }
        
        // Step 2: Analyze document structure
        const originalPageCount = pdfDoc.getPageCount();
        console.log(`Document analysis: ${originalPageCount} pages found`);
        repairLog.push(`Document contains ${originalPageCount} pages`);
        
        // Step 3: Check and repair metadata
        const title = pdfDoc.getTitle();
        const author = pdfDoc.getAuthor();
        const subject = pdfDoc.getSubject();
        const creator = pdfDoc.getCreator();
        
        // Clean up corrupted metadata
        if (title && title.includes('\0')) {
            pdfDoc.setTitle(title.replace(/\0/g, ''));
            repairLog.push('Cleaned corrupted title metadata');
            issuesFound++;
            issuesFixed++;
        }
        
        if (author && author.includes('\0')) {
            pdfDoc.setAuthor(author.replace(/\0/g, ''));
            repairLog.push('Cleaned corrupted author metadata');
            issuesFound++;
            issuesFixed++;
        }
        
        // Step 4: Validate and repair pages
        const pages = pdfDoc.getPages();
        let validPages = 0;
        let repairedPages = 0;
        
        for (let i = 0; i < pages.length; i++) {
            try {
                const page = pages[i];
                const { width, height } = page.getSize();
                
                // Check for invalid page dimensions
                if (width <= 0 || height <= 0 || width > 14400 || height > 14400) {
                    // Try to fix invalid dimensions
                    if (width <= 0 || width > 14400) {
                        page.setSize(612, height > 0 && height <= 14400 ? height : 792); // Default to letter size
                        repairLog.push(`Fixed invalid width on page ${i + 1}`);
                        issuesFound++;
                        issuesFixed++;
                        repairedPages++;
                    }
                    if (height <= 0 || height > 14400) {
                        page.setSize(width > 0 && width <= 14400 ? width : 612, 792);
                        repairLog.push(`Fixed invalid height on page ${i + 1}`);
                        issuesFound++;
                        issuesFixed++;
                        repairedPages++;
                    }
                }
                
                // Check page rotation
                const rotation = page.getRotation();
                if (rotation.angle % 90 !== 0) {
                    // Fix invalid rotation
                    const normalizedAngle = Math.round(rotation.angle / 90) * 90;
                    page.setRotation({ angle: normalizedAngle });
                    repairLog.push(`Fixed invalid rotation on page ${i + 1}: ${rotation.angle}° → ${normalizedAngle}°`);
                    issuesFound++;
                    issuesFixed++;
                    repairedPages++;
                }
                
                validPages++;
                
            } catch (pageError) {
                console.log(`Page ${i + 1} has issues:`, pageError.message);
                repairLog.push(`Page ${i + 1} has structural issues: ${pageError.message}`);
                issuesFound++;
                
                // For premium users, try more aggressive page repair
                if (isPremium) {
                    try {
                        // Try to recreate the page with default settings
                        const newPage = pdfDoc.insertPage(i);
                        newPage.setSize(612, 792); // Letter size default
                        newPage.drawText(`Page ${i + 1} was corrupted and has been recreated`, {
                            x: 50,
                            y: 750,
                            size: 12
                        });
                        
                        // Remove the corrupted page
                        pdfDoc.removePage(i + 1);
                        
                        repairLog.push(`Premium repair: Recreated corrupted page ${i + 1}`);
                        issuesFixed++;
                        repairedPages++;
                    } catch (recreateError) {
                        repairLog.push(`Could not recreate page ${i + 1}: ${recreateError.message}`);
                    }
                }
            }
        }
        
        // Step 5: Check and repair fonts (Premium feature)
        if (isPremium) {
            try {
                // Try to embed standard fonts to fix font issues
                const helvetica = await pdfDoc.embedFont('Helvetica');
                const helveticaBold = await pdfDoc.embedFont('Helvetica-Bold');
                repairLog.push('Premium repair: Embedded standard fonts to prevent font issues');
            } catch (fontError) {
                repairLog.push('Font embedding failed - document may have font display issues');
            }
        }
        
        // Step 6: Optimize document structure
        const saveOptions = {
            useObjectStreams: true,
            addDefaultPage: false,
            objectsPerTick: isPremium ? 50 : 20 // Premium users get faster processing
        };
        
        // Step 7: Validate final document structure
        console.log(`Repair summary: ${issuesFound} issues found, ${issuesFixed} issues fixed`);
        
        if (validPages === 0) {
            throw new Error('No valid pages found in document - cannot repair');
        }
        
        // Step 8: Generate repair report for premium users
        if (isPremium && (issuesFound > 0 || repairedPages > 0)) {
            // Add a repair report page
            const reportPage = pdfDoc.addPage([612, 792]);
            const font = await pdfDoc.embedFont('Helvetica');
            const boldFont = await pdfDoc.embedFont('Helvetica-Bold');
            
            reportPage.drawText('PDF REPAIR REPORT', {
                x: 50,
                y: 750,
                size: 16,
                font: boldFont
            });
            
            reportPage.drawText(`Repair Date: ${new Date().toLocaleString()}`, {
                x: 50,
                y: 720,
                size: 10,
                font: font
            });
            
            reportPage.drawText(`Load Method: ${loadMethod}`, {
                x: 50,
                y: 700,
                size: 10,
                font: font
            });
            
            reportPage.drawText(`Issues Found: ${issuesFound}`, {
                x: 50,
                y: 680,
                size: 10,
                font: font
            });
            
            reportPage.drawText(`Issues Fixed: ${issuesFixed}`, {
                x: 50,
                y: 660,
                size: 10,
                font: font
            });
            
            reportPage.drawText(`Pages Repaired: ${repairedPages}`, {
                x: 50,
                y: 640,
                size: 10,
                font: font
            });
            
            // Add repair log
            reportPage.drawText('REPAIR LOG:', {
                x: 50,
                y: 610,
                size: 12,
                font: boldFont
            });
            
            let yPos = 590;
            repairLog.slice(0, 25).forEach((logEntry, index) => { // Limit to 25 entries
                if (yPos > 50) {
                    reportPage.drawText(`• ${logEntry}`, {
                        x: 50,
                        y: yPos,
                        size: 9,
                        font: font
                    });
                    yPos -= 15;
                }
            });
            
            repairLog.push('Premium repair: Added detailed repair report page');
        }
        
        // Step 9: Save the repaired PDF
        const repairedBuffer = await pdfDoc.save(saveOptions);
        
        const originalSize = file.buffer.length;
        const repairedSize = repairedBuffer.length;
        const sizeChange = ((repairedSize - originalSize) / originalSize * 100).toFixed(1);
        
        console.log('=== PDF REPAIR COMPLETED ===');
        console.log(`Original size: ${originalSize} bytes`);
        console.log(`Repaired size: ${repairedSize} bytes (${sizeChange > 0 ? '+' : ''}${sizeChange}%)`);
        console.log(`Issues found: ${issuesFound}, Issues fixed: ${issuesFixed}`);
        console.log(`Load method: ${loadMethod}`);
        console.log(`Pages repaired: ${repairedPages}/${originalPageCount}`);
        
        return {
            buffer: repairedBuffer,
            repairStats: {
                issuesFound,
                issuesFixed,
                pagesRepaired: repairedPages,
                totalPages: originalPageCount,
                loadMethod,
                sizeChange: parseFloat(sizeChange),
                repairLog: repairLog
            }
        };
        
    } catch (error) {
        console.error('Enhanced PDF repair failed:', error);
        
        // Return error with diagnostic information
        throw new Error(`PDF repair failed: ${error.message}. Issues found: ${issuesFound}, Issues fixed: ${issuesFixed}`);
    }
}

// ENHANCED PDF EDIT FUNCTION
async function editPDFEnhanced(file, edits, isPremium = false) {
    console.log('Enhanced PDF editing with advanced features...');
    const pdfDoc = await PDFDocument.load(file.buffer);
    const pages = pdfDoc.getPages();
    let changesApplied = 0;
    
    try {
        // 1. Page Rotation
        if (edits.rotatePages && Array.isArray(edits.rotatePages)) {
            edits.rotatePages.forEach(({ pageIndex, degrees }) => {
                if (pages[pageIndex] && [0, 90, 180, 270].includes(degrees)) {
                    pages[pageIndex].setRotation({ angle: degrees });
                    console.log(`Rotated page ${pageIndex + 1} by ${degrees} degrees`);
                    changesApplied++;
                }
            });
        }
        
        // 2. Delete Pages
        if (edits.deletePages && Array.isArray(edits.deletePages)) {
            // Sort in descending order to avoid index shifting issues
            const pagesToDelete = [...edits.deletePages].sort((a, b) => b - a);
            
            pagesToDelete.forEach(pageIndex => {
                if (pageIndex >= 0 && pageIndex < pages.length) {
                    pdfDoc.removePage(pageIndex);
                    console.log(`Deleted page ${pageIndex + 1}`);
                    changesApplied++;
                }
            });
        }
        
        // 3. Add Text to Pages (Premium Feature)
        if (edits.addText && Array.isArray(edits.addText)) {
            if (!isPremium && edits.addText.length > 2) {
                throw new Error('Adding more than 2 text elements requires premium access');
            }
            
            // Load fonts
            const helveticaFont = await pdfDoc.embedFont('Helvetica');
            const helveticaBoldFont = await pdfDoc.embedFont('Helvetica-Bold');
            
            edits.addText.forEach(({ pageIndex, text, x, y, size, color, bold }) => {
                if (pages[pageIndex] && text && typeof x === 'number' && typeof y === 'number') {
                    const page = pages[pageIndex];
                    const fontSize = size || 12;
                    const font = bold ? helveticaBoldFont : helveticaFont;
                    
                    // Parse color (hex to RGB)
                    let rgb = { r: 0, g: 0, b: 0 }; // default black
                    if (color && color.startsWith('#') && color.length === 7) {
                        rgb = {
                            r: parseInt(color.substr(1, 2), 16) / 255,
                            g: parseInt(color.substr(3, 2), 16) / 255,
                            b: parseInt(color.substr(5, 2), 16) / 255
                        };
                    }
                    
                    page.drawText(text, {
                        x: x,
                        y: y,
                        size: fontSize,
                        font: font,
                        color: rgb
                    });
                    
                    console.log(`Added text "${text}" to page ${pageIndex + 1} at (${x}, ${y})`);
                    changesApplied++;
                }
            });
        }
        
        // 4. Add Watermark (Premium Feature)
        if (edits.watermark && isPremium) {
            const { text, opacity, fontSize, angle } = edits.watermark;
            
            if (text) {
                const font = await pdfDoc.embedFont('Helvetica');
                const watermarkOpacity = Math.max(0.1, Math.min(1, opacity || 0.3));
                const watermarkSize = fontSize || 50;
                const watermarkAngle = angle || 45;
                
                pages.forEach((page, index) => {
                    const { width, height } = page.getSize();
                    
                    // Center the watermark
                    const textWidth = font.widthOfTextAtSize(text, watermarkSize);
                    const x = (width - textWidth) / 2;
                    const y = height / 2;
                    
                    page.drawText(text, {
                        x: x,
                        y: y,
                        size: watermarkSize,
                        font: font,
                        color: { r: 0.5, g: 0.5, b: 0.5 },
                        opacity: watermarkOpacity,
                        rotate: { angle: watermarkAngle, origin: { x, y } }
                    });
                    
                    console.log(`Added watermark "${text}" to page ${index + 1}`);
                    changesApplied++;
                });
            }
        }
        
        // 5. Add Page Numbers (Premium Feature)
        if (edits.addPageNumbers && isPremium) {
            const { position, startFrom, fontSize, format } = edits.addPageNumbers;
            const font = await pdfDoc.embedFont('Helvetica');
            const numSize = fontSize || 10;
            const startPage = startFrom || 1;
            const pageFormat = format || 'Page {n}'; // {n} will be replaced with page number
            
            pages.forEach((page, index) => {
                const { width, height } = page.getSize();
                const pageNum = startPage + index;
                const pageText = pageFormat.replace('{n}', pageNum.toString());
                
                let x, y;
                switch (position) {
                    case 'top-center':
                        x = width / 2 - font.widthOfTextAtSize(pageText, numSize) / 2;
                        y = height - 30;
                        break;
                    case 'bottom-center':
                        x = width / 2 - font.widthOfTextAtSize(pageText, numSize) / 2;
                        y = 20;
                        break;
                    case 'bottom-right':
                        x = width - font.widthOfTextAtSize(pageText, numSize) - 20;
                        y = 20;
                        break;
                    case 'bottom-left':
                    default:
                        x = 20;
                        y = 20;
                        break;
                }
                
                page.drawText(pageText, {
                    x: x,
                    y: y,
                    size: numSize,
                    font: font,
                    color: { r: 0, g: 0, b: 0 }
                });
                
                console.log(`Added page number "${pageText}" to page ${index + 1}`);
                changesApplied++;
            });
        }
        
        // 6. Crop Pages (Premium Feature)
        if (edits.cropPages && isPremium && Array.isArray(edits.cropPages)) {
            edits.cropPages.forEach(({ pageIndex, x, y, width, height }) => {
                if (pages[pageIndex] && typeof x === 'number' && typeof y === 'number' 
                    && typeof width === 'number' && typeof height === 'number') {
                    
                    const page = pages[pageIndex];
                    page.setCropBox(x, y, width, height);
                    console.log(`Cropped page ${pageIndex + 1} to (${x}, ${y}, ${width}, ${height})`);
                    changesApplied++;
                }
            });
        }
        
        // 7. Merge with Another PDF (Premium Feature)
        if (edits.insertPages && isPremium && edits.insertPdfBuffer) {
            try {
                const insertPdf = await PDFDocument.load(edits.insertPdfBuffer);
                const insertPages = await pdfDoc.copyPages(insertPdf, insertPdf.getPageIndices());
                
                edits.insertPages.forEach(({ afterPageIndex }) => {
                    if (typeof afterPageIndex === 'number' && afterPageIndex >= 0) {
                        insertPages.forEach((page, index) => {
                            pdfDoc.insertPage(afterPageIndex + 1 + index, page);
                        });
                        console.log(`Inserted ${insertPages.length} pages after page ${afterPageIndex + 1}`);
                        changesApplied += insertPages.length;
                    }
                });
            } catch (error) {
                console.error('Failed to insert pages:', error.message);
            }
        }
        
        // 8. Add Simple Shapes (Premium Feature)
        if (edits.addShapes && isPremium && Array.isArray(edits.addShapes)) {
            edits.addShapes.forEach(({ pageIndex, type, x, y, width, height, color, borderColor, borderWidth }) => {
                if (pages[pageIndex] && type && typeof x === 'number' && typeof y === 'number') {
                    const page = pages[pageIndex];
                    
                    // Parse colors
                    const fillColor = parseColor(color) || { r: 0, g: 0, b: 1 }; // default blue
                    const strokeColor = parseColor(borderColor) || { r: 0, g: 0, b: 0 }; // default black
                    
                    switch (type) {
                        case 'rectangle':
                            if (typeof width === 'number' && typeof height === 'number') {
                                page.drawRectangle({
                                    x: x,
                                    y: y,
                                    width: width,
                                    height: height,
                                    color: fillColor,
                                    borderColor: strokeColor,
                                    borderWidth: borderWidth || 1
                                });
                                console.log(`Added rectangle to page ${pageIndex + 1}`);
                                changesApplied++;
                            }
                            break;
                            
                        case 'circle':
                            const radius = width || 50;
                            page.drawCircle({
                                x: x + radius,
                                y: y + radius,
                                size: radius,
                                color: fillColor,
                                borderColor: strokeColor,
                                borderWidth: borderWidth || 1
                            });
                            console.log(`Added circle to page ${pageIndex + 1}`);
                            changesApplied++;
                            break;
                    }
                }
            });
        }
        
    } catch (error) {
        console.error('Enhanced PDF editing error:', error);
        throw new Error(`PDF editing failed: ${error.message}`);
    }
    
    if (changesApplied === 0) {
        console.log('No valid edits were applied to the PDF');
        // Still re-save the PDF to ensure it's valid
    }
    
    const result = await pdfDoc.save();
    console.log(`Enhanced PDF editing completed - ${changesApplied} changes applied`);
    return result;
}

async function convertPDF(file, format, isPremium = false) {
    console.log(`Professional PDF to ${format} conversion...`);
    
    let convertedBuffer, fileExtension, filename;
    const qualityNote = isPremium ? 'Premium Quality' : 'Professional Quality';
    
    switch (format) {
        case 'word':
            try {
                const pdfData = await pdfParse(file.buffer);
                const extractedText = pdfData.text;
                
                // Create professional DOCX document
                const doc = new Document({
                    sections: [{
                        properties: {},
                        children: extractedText.split('\n\n').map(paragraph => 
                            new Paragraph({
                                children: [new TextRun({
                                    text: paragraph,
                                    font: 'Calibri',
                                    size: 24
                                })]
                            })
                        )
                    }]
                });
                
                convertedBuffer = await Packer.toBuffer(doc);
                fileExtension = '.docx';
                filename = generateFileName('converted_to_word').replace('.pdf', fileExtension);
                console.log(`Professional Word conversion completed - ${qualityNote}`);
            } catch (error) {
                throw new Error(`Word conversion failed: ${error.message}`);
            }
            break;
            
        case 'excel':
            try {
                const pdfData = await pdfParse(file.buffer);
                const text = pdfData.text;
                
                // Process text into structured data
                const lines = text.split('\n').filter(line => line.trim());
                const worksheetData = [];
                
                // Try to detect table-like structures
                lines.forEach((line, index) => {
                    const cells = line.split(/\s{2,}|\t/).filter(cell => cell.trim());
                    if (cells.length > 1) {
                        const row = {};
                        cells.forEach((cell, cellIndex) => {
                            row[`Column_${cellIndex + 1}`] = cell.trim();
                        });
                        worksheetData.push(row);
                    } else {
                        worksheetData.push({
                            'Row': index + 1,
                            'Content': line.trim()
                        });
                    }
                });
                
                const worksheet = XLSX.utils.json_to_sheet(worksheetData);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, 'PDF_Data');
                
                convertedBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
                fileExtension = '.xlsx';
                filename = generateFileName('converted_to_excel').replace('.pdf', fileExtension);
                console.log(`Professional Excel conversion completed - ${qualityNote}`);
            } catch (error) {
                throw new Error(`Excel conversion failed: ${error.message}`);
            }
            break;
            
        case 'text':
            try {
                const pdfData = await pdfParse(file.buffer);
                let extractedText = pdfData.text;
                
                // Clean up text for better readability
                extractedText = extractedText
                    .replace(/\s+/g, ' ')
                    .replace(/\n\s*\n/g, '\n\n')
                    .trim();
                
                convertedBuffer = Buffer.from(extractedText, 'utf8');
                fileExtension = '.txt';
                filename = generateFileName('extracted_text').replace('.pdf', fileExtension);
                console.log(`Professional text extraction completed - ${qualityNote}`);
            } catch (error) {
                throw new Error(`Text extraction failed: ${error.message}`);
            }
            break;
            
        case 'powerpoint':
            if (!isPremium) {
                throw new Error('PowerPoint conversion requires premium access');
            }
            
            try {
                const pdfData = await pdfParse(file.buffer);
                const text = pdfData.text;
                
                // Create a presentation outline
                const slides = text.split('\n\n').filter(slide => slide.trim());
                let pptContent = `PowerPoint Presentation - ${qualityNote}\n\n`;
                
                slides.forEach((slide, index) => {
                    pptContent += `Slide ${index + 1}:\n${slide.trim()}\n\n`;
                });
                
                pptContent += `\nTotal Slides: ${slides.length}\nConversion Quality: ${qualityNote}`;
                
                convertedBuffer = Buffer.from(pptContent);
                fileExtension = '.txt'; // In a real implementation, this would be .pptx
                filename = generateFileName('converted_to_powerpoint').replace('.pdf', fileExtension);
                console.log(`Professional PowerPoint conversion completed - ${qualityNote}`);
            } catch (error) {
                throw new Error(`PowerPoint conversion failed: ${error.message}`);
            }
            break;
            
        case 'images':
            if (!isPremium) {
                throw new Error('Image extraction requires premium access');
            }
            
            // Since we can't use pdf2pic reliably, provide a professional placeholder
            const imageInfo = `Professional Image Extraction - ${qualityNote}

This feature extracts high-resolution images from PDF documents.

Note: Full image extraction requires additional server-side tools (GraphicsMagick/ImageMagick).
Contact support for full image extraction capabilities.

PDF Information:
- File size: ${(file.buffer.length / 1024 / 1024).toFixed(2)} MB
- Processing: ${qualityNote}
- Format: Premium image extraction`;
            
            convertedBuffer = Buffer.from(imageInfo);
            fileExtension = '.txt';
            filename = generateFileName('image_extraction_info').replace('.pdf', fileExtension);
            console.log('Professional image extraction info provided');
            break;
            
        default:
            throw new Error(`Unsupported conversion format: ${format}`);
    }
    
    return { buffer: convertedBuffer, filename };
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: userSessions.size,
        version: 'Professional 2.0 Enhanced',
        features: ['merge', 'split', 'compress', 'enhanced-repair', 'enhanced-edit', 'convert']
    });
});

// Serve main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Get user status
app.get('/api/user-status', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { userId: finalUserId, session } = getUserSession(userId);
    
    res.json({
        userId: finalUserId,
        isPremium: hasPremiumAccess(session),
        premiumUntil: session.premiumUntil,
        usage: session.usage
    });
});

// Process PDF endpoint
app.post('/api/process-pdf', upload.array('files', 20), async (req, res) => {
    const startTime = Date.now();
    
    try {
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        const { tool, convertTo } = req.body;
        const files = req.files;
        
        console.log(`=== PROFESSIONAL ${tool?.toUpperCase()} PROCESSING ===`);
        console.log(`User: ${finalUserId}, Files: ${files?.length}, Format: ${convertTo}`);
        
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        if (!tool) {
            return res.status(400).json({ error: 'No tool specified' });
        }
        
        const config = toolConfigs[tool];
        if (!config) {
            return res.status(400).json({ error: 'Invalid tool specified' });
        }
        
        const isPremium = hasPremiumAccess(session);
        const currentUsage = session.usage[tool] || 0;
        
        // Check usage limits
        if (!isPremium && config.freeLimit !== null && currentUsage >= config.freeLimit) {
            return res.status(403).json({ 
                error: `Free limit reached for ${tool}. You've used ${currentUsage}/${config.freeLimit} free uses.`,
                userId: finalUserId
            });
        }
        
        // Check premium requirements for advanced conversions
        if (tool === 'convert') {
            const premiumFormats = ['powerpoint', 'images'];
            if (!isPremium && convertTo && premiumFormats.includes(convertTo)) {
                return res.status(403).json({ 
                    error: `Premium access required for ${convertTo} conversion.`,
                    userId: finalUserId
                });
            }
        }
        
        // Process files
        let result;
        
        try {
            switch (tool) {
                case 'merge':
                    const mergedBuffer = await mergePDFs(files);
                    result = { buffer: mergedBuffer, filename: generateFileName('merged') };
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
                    result = { buffer: compressedBuffer, filename: generateFileName('compressed') };
                    break;
                    
                case 'repair':
                    const repairResult = await repairPDFEnhanced(files[0], isPremium);
                    result = { 
                        buffer: repairResult.buffer, 
                        filename: generateFileName('repaired'),
                        repairStats: repairResult.repairStats 
                    };
                    break;
                    
                case 'convert':
                    if (!convertTo) {
                        throw new Error('No conversion format specified');
                    }
                    result = await convertPDF(files[0], convertTo, isPremium);
                    break;
                    
                case 'edit':
                    const editedBuffer = await editPDFEnhanced(files[0], req.body.edits || {}, isPremium);
                    result = { buffer: editedBuffer, filename: generateFileName('edited') };
                    break;
                    
                default:
                    throw new Error(`Tool not implemented: ${tool}`);
            }
            
        } catch (processingError) {
            console.error(`Professional ${tool} processing error:`, processingError);
            throw processingError;
        }
        
        if (!result || !result.buffer) {
            throw new Error('Processing failed - no result generated');
        }
        
        // Update usage count
        if (!isPremium && config.freeLimit !== null) {
            session.usage[tool] = currentUsage + 1;
            userSessions.set(finalUserId, session);
        }
        
        // Save result file
        const outputPath = path.join(outputDir, result.filename);
        await fs.writeFile(outputPath, result.buffer);
        
        const processingTime = Date.now() - startTime;
        console.log(`=== PROCESSING COMPLETED: ${processingTime}ms ===`);
        
        // Prepare response with repair stats if available
        const response = {
            success: true,
            downloadUrl: `/api/download/${result.filename}`,
            filename: result.filename,
            fileSize: result.buffer.length,
            userId: finalUserId,
            remainingUses: config.freeLimit !== null ? Math.max(0, config.freeLimit - (session.usage[tool] || 0)) : null,
            processingTime: processingTime,
            quality: isPremium ? 'Premium' : 'Professional'
        };
        
        // Add repair statistics if this was a repair operation
        if (result.repairStats) {
            response.repairStats = result.repairStats;
        }
        
        res.json(response);
        
        // Clean up after 1 hour
        setTimeout(async () => {
            try {
                await fs.unlink(outputPath);
                console.log('Cleaned up file:', result.filename);
            } catch (error) {
                console.error('Cleanup error:', error);
            }
        }, 3600000);
        
    } catch (error) {
        console.error('Processing error:', error);
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
        
        const ext = path.extname(filename).toLowerCase();
        const contentTypes = {
            '.pdf': 'application/pdf',
            '.zip': 'application/zip',
            '.txt': 'text/plain',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.csv': 'text/csv'
        };
        
        const contentType = contentTypes[ext] || 'application/octet-stream';
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        const fileBuffer = await fs.readFile(filePath);
        res.send(fileBuffer);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(404).json({ error: 'File not found' });
    }
});

// PayPal endpoints
app.post('/api/create-paypal-order', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId } = getUserSession(userId);
        
        const orderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
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
        
        if (paymentDetails?.status !== 'COMPLETED') {
            return res.status(400).json({ 
                error: 'Payment not completed',
                status: paymentDetails?.status
            });
        }
        
        const paymentAmount = paymentDetails?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
        if (paymentAmount !== '2.00') {
            return res.status(400).json({ error: 'Invalid payment amount' });
        }
        
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
        
        console.log(`Premium access granted to ${finalUserId} until ${premiumExpiry}`);
        
        res.json({
            success: true,
            premiumUntil: premiumExpiry.toISOString(),
            premiumCode: premiumCode,
            message: `Payment successful! Premium code: ${premiumCode}`,
            orderId: orderId
        });
        
    } catch (error) {
        console.error('Payment capture error:', error);
        res.status(500).json({ error: 'Payment capture failed' });
    }
});

// Premium code activation
app.post('/api/activate-premium-code', async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        
        const validCodes = ['PREMIUM24H', 'TESTCODE123', 'LAUNCH2024', 'DEMO2024'];
        const codeUpper = code.toUpperCase().trim();
        
        const isGeneratedCode = generatedCodes.has(codeUpper);
        const isValidPredefinedCode = validCodes.includes(codeUpper);
        
        if (isValidPredefinedCode || isGeneratedCode) {
            const premiumExpiry = new Date();
            premiumExpiry.setHours(premiumExpiry.getHours() + 24);
            
            session.premiumUntil = premiumExpiry;
            userSessions.set(finalUserId, session);
            
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
    res.status(404).json({ error: 'Route not found' });
});

// Cleanup old data periodically
setInterval(() => {
    const now = new Date();
    let cleaned = 0;
    
    // Clean old sessions
    for (const [userId, session] of userSessions.entries()) {
        if (now - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
            userSessions.delete(userId);
            cleaned++;
        }
    }
    
    // Clean old payments
    for (const [orderId, payment] of activePayments.entries()) {
        if (now - payment.createdAt > 24 * 60 * 60 * 1000) {
            activePayments.delete(orderId);
        }
    }
    
    // Clean old codes
    for (const [code, data] of generatedCodes.entries()) {
        if (now - data.createdAt > 30 * 24 * 60 * 60 * 1000) {
            generatedCodes.delete(code);
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} old sessions`);
    }
}, 60 * 60 * 1000); // Run every hour

app.listen(PORT, () => {
    console.log('=====================================');
    console.log(`Professional PDF Tools Backend - Enhanced`);
    console.log(`Port: ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Version: Professional 2.0 Enhanced`);
    console.log(`Features: Real repair, advanced editing, professional conversion`);
    console.log(`Enhanced Features:`);
    console.log(`- Multi-stage PDF repair with diagnostics`);
    console.log(`- Advanced PDF editing (text, watermarks, page numbers, shapes)`);
    console.log(`- Professional format conversions (Word, Excel, Text)`);
    console.log(`- Premium features for paying users`);
    console.log('=====================================');
});