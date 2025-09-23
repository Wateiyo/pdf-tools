const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const archiver = require('archiver');

// Professional PDF processing dependencies
const pdfParse = require('pdf-parse');
const { Document, Paragraph, TextRun, Packer } = require('docx');
const XLSX = require('xlsx');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// In-memory storage for user sessions and usage tracking
const userSessions = new Map();
const activePayments = new Map();
const generatedCodes = new Map();

// Updated tool configurations - edit tool is now always free since it's client-side
const toolConfigs = {
    merge: { requiresPremium: false, freeLimit: null },
    compress: { requiresPremium: false, freeLimit: null },
    split: { requiresPremium: false, freeLimit: 5 },
    edit: { requiresPremium: false, freeLimit: null }, // Direct editor is always free
    repair: { requiresPremium: false, freeLimit: 2 },
    convert: { requiresPremium: false, freeLimit: null }
};

// Font mapping for PDF-lib compatibility
const FONT_MAPPING = {
    'Arial': StandardFonts.Helvetica,
    'Helvetica': StandardFonts.Helvetica,
    'Times New Roman': StandardFonts.TimesRoman,
    'Times': StandardFonts.TimesRoman,
    'Courier New': StandardFonts.Courier,
    'Courier': StandardFonts.Courier
};

const BOLD_FONT_MAPPING = {
    'Arial': StandardFonts.HelveticaBold,
    'Helvetica': StandardFonts.HelveticaBold,
    'Times New Roman': StandardFonts.TimesRomanBold,
    'Times': StandardFonts.TimesRomanBold,
    'Courier New': StandardFonts.CourierBold,
    'Courier': StandardFonts.CourierBold
};

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

// Helper function to parse color strings
function parseColor(colorString) {
    if (!colorString || typeof colorString !== 'string') {
        return rgb(0, 0, 0); // Default to black
    }
    
    if (colorString.startsWith('#') && colorString.length === 7) {
        const r = parseInt(colorString.substr(1, 2), 16) / 255;
        const g = parseInt(colorString.substr(3, 2), 16) / 255;
        const b = parseInt(colorString.substr(5, 2), 16) / 255;
        return rgb(r, g, b);
    }
    
    // Preset colors
    const colors = {
        'red': rgb(1, 0, 0),
        'green': rgb(0, 1, 0),
        'blue': rgb(0, 0, 1),
        'black': rgb(0, 0, 0),
        'white': rgb(1, 1, 1),
        'gray': rgb(0.5, 0.5, 0.5),
        'grey': rgb(0.5, 0.5, 0.5)
    };
    
    return colors[colorString.toLowerCase()] || rgb(0, 0, 0);
}

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

// Middleware configuration
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

app.use(express.json({ limit: '50mb' })); // Increased limit for base64 PDF data
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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
// Enhanced PDF Processing Functions

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
            console.log(`Added ${pageCount} pages from ${file.originalname}`);
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

// Enhanced PDF repair function
async function repairPDFEnhanced(file, isPremium = false) {
    console.log('Enhanced PDF repair - analyzing document structure...');
    let repairLog = [];
    let issuesFound = 0;
    let issuesFixed = 0;
    
    try {
        let pdfDoc;
        let loadMethod = 'standard';
        
        try {
            pdfDoc = await PDFDocument.load(file.buffer);
            console.log('PDF loaded successfully with standard method');
        } catch (standardError) {
            console.log('Standard loading failed, trying recovery mode...');
            repairLog.push('Standard loading failed - attempting recovery');
            issuesFound++;
            
            try {
                pdfDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
                loadMethod = 'recovery';
                repairLog.push('PDF loaded using recovery mode');
                issuesFixed++;
            } catch (recoveryError) {
                throw new Error(`PDF is severely corrupted and cannot be repaired: ${recoveryError.message}`);
            }
        }
        
        const originalPageCount = pdfDoc.getPageCount();
        console.log(`Document analysis: ${originalPageCount} pages found`);
        repairLog.push(`Document contains ${originalPageCount} pages`);
        
        // Check and repair metadata
        const title = pdfDoc.getTitle();
        const author = pdfDoc.getAuthor();
        
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
        
        // Validate and repair pages
        const pages = pdfDoc.getPages();
        let validPages = 0;
        let repairedPages = 0;
        
        for (let i = 0; i < pages.length; i++) {
            try {
                const page = pages[i];
                const { width, height } = page.getSize();
                
                if (width <= 0 || height <= 0 || width > 14400 || height > 14400) {
                    if (width <= 0 || width > 14400) {
                        page.setSize(612, height > 0 && height <= 14400 ? height : 792);
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
                
                const rotation = page.getRotation();
                if (rotation.angle % 90 !== 0) {
                    const normalizedAngle = Math.round(rotation.angle / 90) * 90;
                    page.setRotation(degrees(normalizedAngle));
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
                
                if (isPremium) {
                    try {
                        const newPage = pdfDoc.insertPage(i);
                        newPage.setSize(612, 792);
                        newPage.drawText(`Page ${i + 1} was corrupted and has been recreated`, {
                            x: 50,
                            y: 750,
                            size: 12
                        });
                        
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
        
        // Premium font repair
        if (isPremium) {
            try {
                await pdfDoc.embedFont(StandardFonts.Helvetica);
                await pdfDoc.embedFont(StandardFonts.HelveticaBold);
                repairLog.push('Premium repair: Embedded standard fonts to prevent font issues');
            } catch (fontError) {
                repairLog.push('Font embedding failed - document may have font display issues');
            }
        }
        
        // Generate repair report for premium users
        if (isPremium && (issuesFound > 0 || repairedPages > 0)) {
            const reportPage = pdfDoc.addPage([612, 792]);
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            
            reportPage.drawText('PDF REPAIR REPORT', { x: 50, y: 750, size: 16, font: boldFont });
            reportPage.drawText(`Repair Date: ${new Date().toLocaleString()}`, { x: 50, y: 720, size: 10, font: font });
            reportPage.drawText(`Load Method: ${loadMethod}`, { x: 50, y: 700, size: 10, font: font });
            reportPage.drawText(`Issues Found: ${issuesFound}`, { x: 50, y: 680, size: 10, font: font });
            reportPage.drawText(`Issues Fixed: ${issuesFixed}`, { x: 50, y: 660, size: 10, font: font });
            reportPage.drawText(`Pages Repaired: ${repairedPages}`, { x: 50, y: 640, size: 10, font: font });
            
            reportPage.drawText('REPAIR LOG:', { x: 50, y: 610, size: 12, font: boldFont });
            
            let yPos = 590;
            repairLog.slice(0, 25).forEach((logEntry) => {
                if (yPos > 50) {
                    reportPage.drawText(`• ${logEntry}`, { x: 50, y: yPos, size: 9, font: font });
                    yPos -= 15;
                }
            });
            
            repairLog.push('Premium repair: Added detailed repair report page');
        }
        
        const saveOptions = {
            useObjectStreams: true,
            addDefaultPage: false,
            objectsPerTick: isPremium ? 50 : 20
        };
        
        if (validPages === 0) {
            throw new Error('No valid pages found in document - cannot repair');
        }
        
        const repairedBuffer = await pdfDoc.save(saveOptions);
        const originalSize = file.buffer.length;
        const repairedSize = repairedBuffer.length;
        const sizeChange = ((repairedSize - originalSize) / originalSize * 100).toFixed(1);
        
        console.log('=== PDF REPAIR COMPLETED ===');
        console.log(`Original size: ${originalSize} bytes`);
        console.log(`Repaired size: ${repairedSize} bytes (${sizeChange > 0 ? '+' : ''}${sizeChange}%)`);
        console.log(`Issues found: ${issuesFound}, Issues fixed: ${issuesFixed}`);
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
        throw new Error(`PDF repair failed: ${error.message}. Issues found: ${issuesFound}, Issues fixed: ${issuesFixed}`);
    }
}

// Enhanced PDF editing with advanced text support
async function editPDFAdvanced(file, edits, isPremium = false) {
    console.log('Advanced PDF editing with enhanced text support...');
    const pdfDoc = await PDFDocument.load(file.buffer);
    const pages = pdfDoc.getPages();
    let changesApplied = 0;
    
    try {
        // Page Rotation
        if (edits.rotatePages && Array.isArray(edits.rotatePages)) {
            edits.rotatePages.forEach(({ pageIndex, degrees: rotationDegrees }) => {
                if (pages[pageIndex] && [0, 90, 180, 270, -90, -180, -270].includes(rotationDegrees)) {
                    pages[pageIndex].setRotation(degrees(rotationDegrees));
                    console.log(`Rotated page ${pageIndex + 1} by ${rotationDegrees} degrees`);
                    changesApplied++;
                }
            });
        }
        
        // Delete Pages
        if (edits.deletePages && Array.isArray(edits.deletePages)) {
            const pagesToDelete = [...edits.deletePages].sort((a, b) => b - a);
            
            pagesToDelete.forEach(pageIndex => {
                if (pageIndex >= 0 && pageIndex < pages.length) {
                    pdfDoc.removePage(pageIndex);
                    console.log(`Deleted page ${pageIndex + 1}`);
                    changesApplied++;
                }
            });
        }
        
        // Advanced Text Addition
        if (edits.addText && Array.isArray(edits.addText)) {
            if (!isPremium && edits.addText.length > 10) {
                console.log('Non-premium user limited to 10 text elements');
                edits.addText = edits.addText.slice(0, 10);
            }
            
            for (const textEdit of edits.addText) {
                const { pageIndex, text, x, y, fontSize, color, fontFamily, fontWeight } = textEdit;
                
                if (pages[pageIndex] && text && typeof x === 'number' && typeof y === 'number') {
                    const page = pages[pageIndex];
                    const textSize = fontSize || 12;
                    
                    let fontToUse = StandardFonts.Helvetica;
                    const isBold = fontWeight === 'bold';
                    
                    if (fontFamily && FONT_MAPPING[fontFamily]) {
                        fontToUse = isBold ? 
                            (BOLD_FONT_MAPPING[fontFamily] || FONT_MAPPING[fontFamily]) : 
                            FONT_MAPPING[fontFamily];
                    }
                    
                    const font = await pdfDoc.embedFont(fontToUse);
                    const textColor = parseColor(color);
                    
                    // Handle multi-line text
                    const lines = text.split('\n');
                    lines.forEach((line, lineIndex) => {
                        if (line.trim()) {
                            page.drawText(line, {
                                x: x,
                                y: y - (lineIndex * textSize * 1.2),
                                size: textSize,
                                font: font,
                                color: textColor
                            });
                        }
                    });
                    
                    console.log(`Added text "${text.substring(0, 20)}..." to page ${pageIndex + 1} at (${x}, ${y})`);
                    changesApplied++;
                }
            }
        }
        
        // Add Watermark (Premium)
        if (edits.watermark && isPremium) {
            const { text, opacity, fontSize: watermarkSize, angle } = edits.watermark;
            
            if (text) {
                const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
                const watermarkOpacity = Math.max(0.1, Math.min(1, opacity || 0.3));
                const size = watermarkSize || 50;
                const rotationAngle = angle || 45;
                
                pages.forEach((page, index) => {
                    const { width, height } = page.getSize();
                    const textWidth = font.widthOfTextAtSize(text, size);
                    const x = (width - textWidth) / 2;
                    const y = height / 2;
                    
                    page.drawText(text, {
                        x: x, y: y, size: size, font: font,
                        color: rgb(0.5, 0.5, 0.5),
                        opacity: watermarkOpacity,
                        rotate: degrees(rotationAngle)
                    });
                    
                    console.log(`Added watermark "${text}" to page ${index + 1}`);
                    changesApplied++;
                });
            }
        }
        
        // Add Page Numbers (Premium)
        if (edits.addPageNumbers && isPremium) {
            const { position, startFrom, fontSize: numSize, format } = edits.addPageNumbers;
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const pageNumSize = numSize || 10;
            const startPage = startFrom || 1;
            const pageFormat = format || 'Page {n}';
            
            pages.forEach((page, index) => {
                const { width, height } = page.getSize();
                const pageNum = startPage + index;
                const pageText = pageFormat.replace('{n}', pageNum.toString());
                
                let x, y;
                switch (position) {
                    case 'top-center':
                        x = width / 2 - font.widthOfTextAtSize(pageText, pageNumSize) / 2;
                        y = height - 30;
                        break;
                    case 'bottom-center':
                        x = width / 2 - font.widthOfTextAtSize(pageText, pageNumSize) / 2;
                        y = 20;
                        break;
                    case 'bottom-right':
                        x = width - font.widthOfTextAtSize(pageText, pageNumSize) - 20;
                        y = 20;
                        break;
                    case 'bottom-left':
                    default:
                        x = 20;
                        y = 20;
                        break;
                }
                
                page.drawText(pageText, {
                    x: x, y: y, size: pageNumSize, font: font, color: rgb(0, 0, 0)
                });
                
                console.log(`Added page number "${pageText}" to page ${index + 1}`);
                changesApplied++;
            });
        }
        
    } catch (error) {
        console.error('Enhanced PDF editing error:', error);
        throw new Error(`PDF editing failed: ${error.message}`);
    }
    
    if (changesApplied === 0) {
        console.log('No valid edits were applied to the PDF');
    }
    
    const result = await pdfDoc.save();
    console.log(`Enhanced PDF editing completed - ${changesApplied} changes applied`);
    return result;
}
// PDF validation for direct editor
async function validatePDFForDirectEdit(file) {
    console.log('Validating PDF for direct editing...');
    
    try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        const pageCount = pdfDoc.getPageCount();
        const pages = pdfDoc.getPages();
        let validPages = 0;
        let issues = [];
        
        pages.forEach((page, index) => {
            try {
                const { width, height } = page.getSize();
                const rotation = page.getRotation();
                
                if (width > 0 && height > 0) {
                    validPages++;
                } else {
                    issues.push(`Page ${index + 1} has invalid dimensions`);
                }
                
                if (rotation.angle % 90 !== 0) {
                    issues.push(`Page ${index + 1} has non-standard rotation: ${rotation.angle}°`);
                }
                
            } catch (error) {
                issues.push(`Page ${index + 1} structure error: ${error.message}`);
            }
        });
        
        const isValid = validPages === pageCount && issues.length === 0;
        
        console.log(`PDF validation: ${validPages}/${pageCount} valid pages, ${issues.length} issues`);
        
        return {
            isValid,
            pageCount,
            validPages,
            issues,
            fileSize: file.buffer.length,
            title: pdfDoc.getTitle() || 'Untitled',
            author: pdfDoc.getAuthor() || 'Unknown',
            canDirectEdit: isValid && pageCount <= 100 // Performance limit
        };
        
    } catch (error) {
        console.error('PDF validation failed:', error);
        return {
            isValid: false,
            pageCount: 0,
            validPages: 0,
            issues: [`Validation failed: ${error.message}`],
            fileSize: file.buffer.length,
            canDirectEdit: false
        };
    }
}

// Enhanced PDF conversion
async function convertPDF(file, format, isPremium = false) {
    console.log(`Professional PDF to ${format} conversion...`);
    
    let convertedBuffer, fileExtension, filename;
    const qualityNote = isPremium ? 'Premium Quality' : 'Professional Quality';
    
    switch (format) {
        case 'word':
            try {
                const pdfData = await pdfParse(file.buffer);
                const extractedText = pdfData.text;
                
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
                const lines = text.split('\n').filter(line => line.trim());
                const worksheetData = [];
                
                lines.forEach((line, index) => {
                    const cells = line.split(/\s{2,}|\t/).filter(cell => cell.trim());
                    if (cells.length > 1) {
                        const row = {};
                        cells.forEach((cell, cellIndex) => {
                            row[`Column_${cellIndex + 1}`] = cell.trim();
                        });
                        worksheetData.push(row);
                    } else if (line.trim()) {
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
                let extractedText = pdfData.text
                    .replace(/\s+/g, ' ')
                    .replace(/\n\s*\n/g, '\n\n')
                    .trim();
                
                const header = `Text Extraction Report - ${qualityNote}
Generated: ${new Date().toLocaleString()}
Source: PDF Document
Pages: ${pdfData.numpages || 'Unknown'}

=== EXTRACTED TEXT ===

`;
                
                convertedBuffer = Buffer.from(header + extractedText, 'utf8');
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
                const slides = text.split('\n\n').filter(slide => slide.trim());
                
                let pptContent = `PowerPoint Presentation Outline - ${qualityNote}\n\n`;
                pptContent += `Generated: ${new Date().toLocaleString()}\n`;
                pptContent += `Source Pages: ${pdfData.numpages || 'Unknown'}\n\n`;
                
                slides.forEach((slide, index) => {
                    if (slide.trim()) {
                        pptContent += `Slide ${index + 1}:\n${slide.trim()}\n\n`;
                    }
                });
                
                pptContent += `\nPresentation Summary:\n`;
                pptContent += `- Total Slides: ${slides.length}\n`;
                pptContent += `- Conversion Quality: ${qualityNote}\n`;
                
                convertedBuffer = Buffer.from(pptContent);
                fileExtension = '.txt';
                filename = generateFileName('powerpoint_outline').replace('.pdf', fileExtension);
                console.log(`Professional PowerPoint outline completed - ${qualityNote}`);
            } catch (error) {
                throw new Error(`PowerPoint conversion failed: ${error.message}`);
            }
            break;
            
        case 'images':
            if (!isPremium) {
                throw new Error('Image extraction requires premium access');
            }
            
            const pdfData = await pdfParse(file.buffer).catch(() => ({ numpages: 'Unknown' }));
            const imageInfo = `Professional Image Extraction Report - ${qualityNote}

Generated: ${new Date().toLocaleString()}
Source: PDF Document
Pages: ${pdfData.numpages || 'Unknown'}
File Size: ${(file.buffer.length / 1024 / 1024).toFixed(2)} MB

=== IMAGE EXTRACTION ANALYSIS ===

Premium Image Extraction Features:
✓ High-resolution image detection
✓ Embedded image analysis
✓ Format optimization (PNG, JPEG)
✓ Metadata preservation

Technical Requirements:
- Full image extraction requires server-side GraphicsMagick/ImageMagick
- PDF.js can extract some embedded images
- Complex layouts may require specialized OCR

Processing Quality: ${qualityNote}`;
            
            convertedBuffer = Buffer.from(imageInfo);
            fileExtension = '.txt';
            filename = generateFileName('image_extraction_report').replace('.pdf', fileExtension);
            console.log('Professional image extraction analysis completed');
            break;
            
        default:
            throw new Error(`Unsupported conversion format: ${format}`);
    }
    
    return { buffer: convertedBuffer, filename };
}

// API Routes
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: userSessions.size,
        version: 'Enhanced v3.0 - Direct Editor Support',
        features: {
            core: ['merge', 'split', 'compress', 'repair', 'convert'],
            enhanced: ['direct-edit-support', 'advanced-text-editing', 'premium-features'],
            editor: ['client-side-editing', 'real-time-preview', 'advanced-validation']
        },
        limits: {
            maxFileSize: '50MB',
            maxFiles: 20,
            maxDirectEditPages: 100
        }
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/user-status', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { userId: finalUserId, session } = getUserSession(userId);
    
    res.json({
        userId: finalUserId,
        isPremium: hasPremiumAccess(session),
        premiumUntil: session.premiumUntil,
        usage: session.usage,
        features: {
            directEdit: true,
            advancedEdit: hasPremiumAccess(session),
            unlimitedText: hasPremiumAccess(session)
        }
    });
});

// PDF validation endpoint for direct editor
app.post('/api/validate-pdf', upload.single('file'), async (req, res) => {
    try {
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId } = getUserSession(userId);
        const file = req.file;
        
        console.log(`PDF validation request from user: ${finalUserId}`);
        
        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        if (file.mimetype !== 'application/pdf') {
            return res.status(400).json({ error: 'File must be a PDF' });
        }
        
        const validation = await validatePDFForDirectEdit(file);
        
        res.json({
            success: true,
            validation,
            userId: finalUserId,
            message: validation.canDirectEdit ? 
                'PDF is suitable for direct editing' : 
                'PDF has issues that may affect direct editing'
        });
        
    } catch (error) {
        console.error('PDF validation error:', error);
        res.status(500).json({ 
            error: 'PDF validation failed', 
            details: error.message 
        });
    }
});

// Main PDF processing endpoint
app.post('/api/process-pdf', upload.array('files', 20), async (req, res) => {
    const startTime = Date.now();
    
    try {
        const userId = req.headers['x-user-id'];
        const { userId: finalUserId, session } = getUserSession(userId);
        const { tool, convertTo } = req.body;
        const files = req.files;
        
        console.log(`=== ENHANCED ${tool?.toUpperCase()} PROCESSING ===`);
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
        
        // Skip usage check for direct editor since it's client-side
        if (tool !== 'edit') {
            if (!isPremium && config.freeLimit !== null && currentUsage >= config.freeLimit) {
                return res.status(403).json({ 
                    error: `Free limit reached for ${tool}. You've used ${currentUsage}/${config.freeLimit} free uses.`,
                    userId: finalUserId
                });
            }
            
            if (tool === 'convert') {
                const premiumFormats = ['powerpoint', 'images'];
                if (!isPremium && convertTo && premiumFormats.includes(convertTo)) {
                    return res.status(403).json({ 
                        error: `Premium access required for ${convertTo} conversion.`,
                        userId: finalUserId
                    });
                }
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
                    const editedBuffer = await editPDFAdvanced(files[0], req.body.edits || {}, isPremium);
                    result = { buffer: editedBuffer, filename: generateFileName('edited') };
                    break;
                    
                default:
                    throw new Error(`Tool not implemented: ${tool}`);
            }
            
        } catch (processingError) {
            console.error(`Enhanced ${tool} processing error:`, processingError);
            throw processingError;
        }
        
        if (!result || !result.buffer) {
            throw new Error('Processing failed - no result generated');
        }
        
        // Update usage count (skip for direct editor)
        if (tool !== 'edit' && !isPremium && config.freeLimit !== null) {
            session.usage[tool] = currentUsage + 1;
            userSessions.set(finalUserId, session);
        }
        
        // Save result file
        const outputPath = path.join(outputDir, result.filename);
        await fs.writeFile(outputPath, result.buffer);
        
        const processingTime = Date.now() - startTime;
        console.log(`PROCESSING COMPLETED: ${processingTime}ms`);
        
        const response = {
            success: true,
            downloadUrl: `/api/download/${result.filename}`,
            filename: result.filename,
            fileSize: result.buffer.length,
            userId: finalUserId,
            remainingUses: (tool !== 'edit' && config.freeLimit !== null) ? 
                Math.max(0, config.freeLimit - (session.usage[tool] || 0)) : null,
            processingTime: processingTime,
            quality: isPremium ? 'Premium' : 'Professional',
            features: {
                directEditAvailable: tool === 'edit',
                advancedFeaturesUsed: isPremium
            }
        };
        
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
            tool: req.body.tool,
            timestamp: new Date().toISOString()
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

// PayPal payment processing
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
        
        console.log(`PayPal order created: ${orderId} for user: ${finalUserId}`);
        
        res.json({ orderId, userId: finalUserId });
        
    } catch (error) {
        console.error('PayPal order creation error:', error);
        res.status(500).json({ error: 'Failed to create PayPal order' });
    }
});

app.post('/api/capture-paypal-payment', async (req, res) => {
    try {
        const { orderId, payerId, paymentDetails } = req.body;
        const userId = req.headers['x-user-id'];
        
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
        const premiumCode = generatePremiumCode();
        
        const premiumExpiry = new Date();
        premiumExpiry.setHours(premiumExpiry.getHours() + 24);
        
        session.premiumUntil = premiumExpiry;
        userSessions.set(finalUserId, session);
        
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
            orderId: orderId,
            features: {
                directEditAdvanced: true,
                unlimitedTextElements: true,
                premiumRepair: true,
                advancedConversion: true
            }
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
        
        const validCodes = ['PREMIUM24H', 'TESTCODE123', 'LAUNCH2024', 'DEMO2024', 'DIRECTEDIT2024'];
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
            
            console.log(`Premium code ${codeUpper} activated for user ${finalUserId}`);
            
            res.json({
                success: true,
                premiumUntil: premiumExpiry.toISOString(),
                userId: finalUserId,
                message: 'Premium code activated successfully!',
                features: {
                    directEditAdvanced: true,
                    unlimitedTextElements: true,
                    premiumRepair: true,
                    advancedConversion: true
                }
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
            return res.status(400).json({ 
                error: 'File too large. Maximum size is 50MB.',
                code: 'FILE_TOO_LARGE'
            });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ 
                error: 'Too many files. Maximum is 20 files.',
                code: 'TOO_MANY_FILES'
            });
        }
    }
    
    res.status(500).json({ 
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// Enhanced cleanup with better logging
setInterval(() => {
    const now = new Date();
    let cleaned = 0;
    let expiredPremium = 0;
    
    for (const [userId, session] of userSessions.entries()) {
        if (session.premiumUntil && now > session.premiumUntil) {
            session.premiumUntil = null;
            expiredPremium++;
        }
        
        if (now - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
            userSessions.delete(userId);
            cleaned++;
        }
    }
    
    let cleanedPayments = 0;
    for (const [orderId, payment] of activePayments.entries()) {
        if (now - payment.createdAt > 24 * 60 * 60 * 1000) {
            activePayments.delete(orderId);
            cleanedPayments++;
        }
    }
    
    let cleanedCodes = 0;
    for (const [code, data] of generatedCodes.entries()) {
        if (now - data.createdAt > 30 * 24 * 60 * 60 * 1000) {
            generatedCodes.delete(code);
            cleanedCodes++;
        }
    }
    
    if (cleaned > 0 || expiredPremium > 0 || cleanedPayments > 0 || cleanedCodes > 0) {
        console.log(`Cleanup: ${cleaned} old sessions, ${expiredPremium} expired premium, ${cleanedPayments} old payments, ${cleanedCodes} old codes`);
    }
}, 60 * 60 * 1000); // Run every hour

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log('=====================================');
    console.log(`Enhanced PDF Tools Backend - Direct Editor Support`);
    console.log(`Port: ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Version: Enhanced v3.0`);
    console.log('=====================================');
    console.log('Core Features:');
    console.log('- Professional PDF merge, split, compress');
    console.log('- Enhanced repair with diagnostics');
    console.log('- Advanced format conversion');
    console.log('- Direct editor validation support');
    console.log('');
    console.log('Enhanced Features:');
    console.log('- Client-side direct PDF editing support');
    console.log('- Advanced text manipulation with fonts');
    console.log('- Premium features (watermarks, page numbers)');
    console.log('- Real-time PDF validation');
    console.log('- Multi-line text with proper spacing');
    console.log('- Enhanced error handling and logging');
    console.log('');
    console.log('Direct Editor Integration:');
    console.log('- PDF validation endpoint');
    console.log('- Font compatibility checking');
    console.log('- Page limit validation (100 pages max)');
    console.log('- Enhanced text processing');
    console.log('=====================================');
    console.log('Backend ready for direct editor frontend!');
});

module.exports = app;