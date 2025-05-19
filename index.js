const express = require('express');
const multer = require('multer'); // Middleware for handling multipart/form-data
const fs = require('fs').promises; // Import promise-based fs methods
const nodeFs = require('fs'); // Import standard fs methods (including streams)
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require("cors")
const {GoogleGenerativeAI} = require("@google/generative-ai"); // Use @google-cloud/generative-ai for server-side Node.js

// Use firebase-admin instead of client SDKs
const admin = require('firebase-admin');

// Use pdf2json for text extraction
const PDFParser = require('pdf2json');

// Load environment variables from .env file
require('dotenv').config();

// Log the GOOGLE_APPLICATION_CREDENTIALS environment variable status for debugging
const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);

// --- Firebase Admin Initialization ---
// Initialize Firebase Admin SDK
// It automatically uses the GOOGLE_APPLICATION_CREDENTIALS environment variable
// Make sure that environment variable is set before running the script.
// You also need NEXT_PUBLIC_FIREBASE_PROJECT_ID and NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
// set in your .env file for basic configuration.
if (admin.apps.length === 0) {
    try {
        // Validate required environment variables for admin SDK config
        if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || !process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) {
             console.error("FATAL ERROR: NEXT_PUBLIC_FIREBASE_PROJECT_ID and NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET must be set in your .env file for Admin SDK initialization.");
             // Exit immediately as Firebase initialization is critical for storage and database operations
             process.exit(1);
        }

        // IMPORTANT: Remove client-side Firebase config properties (apiKey, authDomain, etc.).
        // When using a service account key (via GOOGLE_APPLICATION_CREDENTIALS), the Admin SDK
        // authenticates directly with Google Cloud, not via typical client-side API keys.
        // You only need to provide the necessary project/service details.
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          storageBucket: "jobform-automator-website.appspot.com",
          databaseURL: "https://jobform-automator-website-default-rtdb.firebaseio.com",
        });
        console.log('Firebase Admin SDK initialized successfully (using GOOGLE_APPLICATION_CREDENTIALS if set).');
    } catch (error) {
        console.error('Error initializing Firebase Admin SDK:', error);
        // Exit if initialization fails, as core services won't work
        process.exit(1);
    }
}

// After successful initialization, get database and bucket references
const database = admin.database();
const bucket = admin.storage().bucket(); // Use the default bucket associated with the project

// --- Gemini Configuration ---
const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
if (!apiKey) {
    console.error("FATAL ERROR: NEXT_PUBLIC_GEMINI_API_KEY is not set in your .env file.");
    // Allow server to start but parsing will fail gracefully
}

// Use @google-cloud/generative-ai which is better suited for server-side Node.js
// The library can also pick up credentials automatically if GOOGLE_APPLICATION_CREDENTIALS is set,
// but for the Gemini API specifically, using the API key is the standard approach.
const genAI = new GoogleGenerativeAI(apiKey || "");

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// --- PDF Text Extraction (using pdf2json and temporary files) ---
const extractTextFromPdf = async (filePath, filename) => {
    // Note: Multer saves files to disk, so we can parse directly from the path
    // without creating our own temporary file from a buffer.
    console.log(`Processing temp file: ${filePath} for ${filename}`);

    // Use pdf2json to extract text
    const pdfParser = new PDFParser();
    let extractedText = '';

    // Wrap pdf2json's event-based parsing in a Promise
    await new Promise((resolve, reject) => {
        pdfParser.on('pdfParser_dataError', (errData) => {
            console.error(`pdf2json error for ${filename}:`, errData.parserError);
            // Check if the error is related to an invalid PDF structure
            if (errData.parserError && (errData.parserError.message.includes("Invalid PDF structure") || errData.parserError.message.includes("Premature end of file"))) {
                reject(new Error(`Invalid or corrupted PDF file: ${filename}`));
            } else {
                 reject(errData.parserError);
            }
        });

        pdfParser.on('pdfParser_dataReady', (pdfData) => {
            console.log(`pdf2json finished parsing ${filename}`);
            // Extract text from pages
            if (pdfData && pdfData.Pages) {
                for (const page of pdfData.Pages) {
                    if (page.Texts) {
                        for (const text of page.Texts) {
                             // Decode URI-encoded text and append
                             // pdf2json often URI encodes text. Re-encode '%' before decoding.
                            try {
                                const textContent = decodeURIComponent(text.R[0].T.replace(/%/g, '%25'));
                                extractedText += textContent + ' ';
                            } catch (decodeError) {
                                extractedText += text.R[0].T + ' ';
                            }
                        }
                    }
                }
            }
            resolve();
        });

        // Parse the temporary file provided by multer
        pdfParser.loadPDF(filePath);
    });

    console.log(`Extracted text (${extractedText.length} chars) from ${filename} using pdf2json.`);

    // Check extracted text length
    if (!extractedText || extractedText.trim().length < 50) {
        console.warn(`Insufficient text extracted from ${filename}: ${extractedText?.length || 0} characters.`);
    }

    return extractedText.trim();
};

// --- Gemini Helper Functions ---
const cleanGeminiJson = (raw) => {
    let cleaned = raw.trim();
    // Remove leading and trailing markdown code block fences
    if (cleaned.startsWith('```json')) {
        const codeBlockEnd = cleaned.indexOf('```', 7);
         if (codeBlockEnd !== -1) {
            cleaned = cleaned.substring(7, codeBlockEnd).trim();
         } else {
            cleaned = cleaned.substring(7).trim();
         }
    } else if (cleaned.startsWith('```')) {
         const codeBlockEnd = cleaned.indexOf('```', 3);
         if (codeBlockEnd !== -1) {
             cleaned = cleaned.substring(3, codeBlockEnd).trim();
         } else {
              cleaned = cleaned.substring(3).trim();
         }
    }

    // Attempt to remove leading/trailing non-JSON characters more robustly
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
    } else {
        console.warn("Could not find valid JSON structure ({...}) within cleaned Gemini output (partial):", cleaned.substring(0, 200) + '...');
    }

    return cleaned;
};

const validateCandidate = (candidateData) => {
    candidateData = candidateData || {};
    const emailInput = candidateData.email && typeof candidateData.email === 'string' ? candidateData.email.trim().toLowerCase() : '';
    const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
    const fallbackEmailFromName = candidateData.name && typeof candidateData.name === 'string' && candidateData.name.trim() !== '' && candidateData.name.trim().toLowerCase() !== 'n/a'
        ? `${candidateData.name.trim().replace(/\s+/g, "").toLocaleLowerCase()}@gmail.com`
        : `unknown_${uuidv4()}@gmail.com`;

    const email = emailInput && emailRegex.test(emailInput)
        ? emailInput
        : fallbackEmailFromName;

    return {
        id: candidateData.id || uuidv4(),
        name: candidateData.name && typeof candidateData.name === 'string' && candidateData.name.trim() !== '' && candidateData.name.trim().toLowerCase() !== 'n/a' ? candidateData.name.trim() : 'Unknown',
        email: email,
        phone: candidateData.phone && typeof candidateData.phone === 'string' && candidateData.phone.trim() !== '' && candidateData.phone.trim().toLowerCase() !== 'n/a' ? candidateData.phone.trim() : 'N/A',
        location: candidateData.location && typeof candidateData.location === 'string' && candidateData.location.trim() !== '' && candidateData.location.trim().toLowerCase() !== 'n/a' ? candidateData.location.trim() : 'N/A',
        score: typeof candidateData.score === 'number' ? Math.max(0, Math.min(100, Math.round(candidateData.score))) : 0,
        parsedText: candidateData.parsedText && typeof candidateData.parsedText === 'string' && candidateData.parsedText.trim() ? candidateData.parsedText.trim() : 'No summary provided.',
        skills: Array.isArray(candidateData.skills) ? candidateData.skills.filter(s => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : [],
        experience: typeof candidateData.experienceYears === 'number' && candidateData.experienceYears >= 0 ? Math.round(candidateData.experienceYears) : 0,
        jobTitle: candidateData.jobTitle && typeof candidateData.jobTitle === 'string' && candidateData.jobTitle.trim() !== '' && candidateData.jobTitle.trim().toLowerCase() !== 'n/a' ? candidateData.jobTitle.trim() : 'N/A',
        education: candidateData.education && typeof candidateData.education === 'string' && candidateData.education.trim() !== '' && candidateData.education.trim().toLowerCase() !== 'n/a' ? candidateData.education.trim() : 'N/A',
        approved: typeof candidateData.approved === 'boolean' ? candidateData.approved : false,
        resumeUrl: candidateData.resumeUrl || 'N/A',
    };
};

const extractEmailFromText = (text) => {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
    const matches = text.match(emailRegex);
    return matches && matches.length > 0 ? matches[0].toLowerCase() : null;
};

const parseWithGemini = async (
    text,
    jobDescription,
    recruiterSuggestion
) => {
    const prompt = `
You are an Advanced AI Resume Evaluator.

Your Task:
Critically evaluate the provided resume text against the given job description (JD) and specific recruiter suggestions (RS). Your evaluation must equally weigh the alignment with the JD (50%) and the alignment with the RS (50%) to generate a final score and detailed analysis.

Inputs:

Job Description (Weight: 50%):
\`\`\`
${jobDescription}
\`\`\`

Recruiter Suggestions (Weight: 50%):
\`\`\`
${recruiterSuggestion}
\`\`\`

Resume Text:
\`\`\`
${text}
\`\`\`

Evaluation Process & Scoring Guidelines:

Analyze Job Description: Identify core requirements, essential skills (technical & soft), required experience (years, type), specific tools/technologies, key responsibilities, and educational prerequisites mentioned in the JD.

Analyze Recruiter Suggestions: Identify specific points of emphasis, desired candidate attributes, potential red flags to watch for, and any formatting or content preferences mentioned in the RS.

Analyze Resume: Extract candidate's contact information, location, work experience (roles, duration, responsibilities, achievements), listed skills, and education.

JD Match Assessment (50% Weight):

Assess the direct match between the candidate's skills/experience and the JD's essential requirements.

Evaluate the relevance and depth of the candidate's experience concerning the JD's responsibilities.

Check for the presence of keywords, tools, and technologies specified in the JD.

Consider the alignment of education and years of experience with JD requirements.

Assign a score out of 100 for JD fit.

RS Match Assessment (50% Weight):

Assess how well the resume addresses the specific points, priorities, and concerns raised in the RS.

Evaluate if the resume avoids any red flags mentioned by the recruiter.

Check if the resume presentation or content aligns with the recruiter's preferences (if specified).

Assign a score out of 100 for RS fit.

Calculate Final Score: Compute the final score as \`(JD Match Score * 0.5) + (RS Match Score * 0.5)\`. Round to the nearest whole number.

Synthesize Evaluation Summary: Write a concise summary (\`parsedText\`) explaining the final score. Highlight key strengths (points of strong alignment with both JD and RS) and weaknesses (significant gaps or areas where the resume fails to meet JD requirements or RS expectations). Be specific.

Output Format:

Return only a JSON object adhering strictly to the following structure. Do not include any text before or after the JSON object.

\`\`\`json
{
"name": "Candidate Name (Extract from resume)",
"email": "example@email.com (Extract from resume)",
"phone": "+1234567890 (Extract from resume)",
"location": "City, State/Country (Extract from resume)",
"score": /* Calculated final score (0-100) */,
"parsedText": "Concise summary explaining the score, highlighting specific strengths and weaknesses based on JD and RS alignment.",
"skills": [ /* List of relevant skills extracted from the resume that match JD/RS requirements */ ],
"experienceYears": /* Total years of relevant experience inferred/extracted from resume */,
"jobTitle": "Most recent relevant job title (Extract from resume)",
"education": "Highest relevant degree/qualification (Extract from resume)"
}
\`\`\`
`;

    try {
        if (!apiKey) {
             console.error("Gemini API key is not configured within parseWithGemini. Skipping Gemini call.");
             return {
                name: 'API Key Missing',
                email: `api_key_missing_${uuidv4()}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: 'Gemini API Key is not configured. Parsing skipped.',
                skills: [],
                experienceYears: 0,
                jobTitle: 'API Key Missing',
                education: 'N/A',
             };
        }

        const extractedEmail = extractEmailFromText(text);
        const SAFETY_MARGIN_TOKENS = 5000;
        const approxPromptTokens = Math.ceil((prompt.length + jobDescription.length + recruiterSuggestion.length) / 4);
        const MAX_TEXT_TOKENS = 1000000 - approxPromptTokens - SAFETY_MARGIN_TOKENS;
        const MAX_TEXT_CHARS = MAX_TEXT_TOKENS * 3;

        let textForGemini = text;
        if (text.length > MAX_TEXT_CHARS) {
            console.warn(`Resume text length (${text.length} chars) exceeds approximate limit (${MAX_TEXT_CHARS} chars). Truncating resume text for prompt.`);
            textForGemini = text.substring(0, MAX_TEXT_CHARS);
        }

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-001"});
        const promptWithText = `
You are an Advanced AI Resume Evaluator.

Your Task:
Critically evaluate the provided resume text against the given job description (JD) and specific recruiter suggestions (RS). Your evaluation must equally weigh the alignment with the JD (50%) and the alignment with the RS (50%) to generate a final score and detailed analysis.

Inputs:

Job Description (Weight: 50%):
\`\`\`
${jobDescription}
\`\`\`

Recruiter Suggestions (Weight: 50%):
\`\`\`
${recruiterSuggestion}
\`\`\`

Resume Text:
\`\`\`
${textForGemini}
\`\`\`

Evaluation Process & Scoring Guidelines:

Analyze Job Description: Identify core requirements, essential skills (technical & soft), required experience (years, type), specific tools/technologies, key responsibilities, and educational prerequisites mentioned in the JD.

Analyze Recruiter Suggestions: Identify specific points of emphasis, desired candidate attributes, potential red flags to watch for, and any formatting or content preferences mentioned in the RS.

Analyze Resume: Extract candidate's contact information, location, work experience (roles, duration, responsibilities, achievements), listed skills, and education.

JD Match Assessment (50% Weight):

Assess the direct match between the candidate's skills/experience and the JD's essential requirements.

Evaluate the relevance and depth of the candidate's experience concerning the JD's responsibilities.

Check for the presence of keywords, tools, and technologies specified in the JD.

Consider the alignment of education and years of experience with JD requirements.

Assign a score out of 100 for JD fit.

RS Match Assessment (50% Weight):

Assess how well the resume addresses the specific points, priorities, and concerns raised in the RS.

Evaluate if the resume avoids any red flags mentioned by the recruiter.

Check if the resume presentation or content aligns with the recruiter's preferences (if specified).

Assign a score out of 100 for RS fit.

Calculate Final Score: Compute the final score as \`(JD Match Score * 0.5) + (RS Match Score * 0.5)\`. Round to the nearest whole number.

Synthesize Evaluation Summary: Write a concise summary (\`parsedText\`) explaining the score. Highlight key strengths (points of strong alignment with both JD and RS) and weaknesses (significant gaps or areas where the resume fails to meet JD requirements or RS expectations). Be specific.

Output Format:

Return only a JSON object adhering strictly to the following structure. Do not include any text before or after the JSON object.

\`\`\`json
{
"name": "Candidate Name (Extract from resume)",
"email": "example@email.com (Extract from resume)",
"phone": "+1234567890 (Extract from resume)",
"location": "City, State/Country (Extract from resume)",
"score": /* Calculated final score (0-100) */,
"parsedText": "Concise summary explaining the score, highlighting specific strengths and weaknesses based on JD and RS alignment.",
"skills": [ /* List of relevant skills extracted from the resume that match JD/RS requirements */ ],
"experienceYears": /* Total years of relevant experience inferred/extracted from resume */,
"jobTitle": "Most recent relevant job title (Extract from resume)",
"education": "Highest relevant degree/qualification (Extract from resume)"
}
\`\`\`
`;

        const result = await model.generateContent(promptWithText);
        if (!result || !result.response || typeof result.response.text !== 'function') {
             console.error("Gemini API returned an unexpected empty result or response format.");
             return {
                name: 'API No Response',
                email: extractedEmail || `api_no_response_${uuidv4()}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: 'Gemini API returned no response or malformed response.',
                skills: [],
                experienceYears: 0,
                jobTitle: 'API Error',
                education: 'N/A',
            };
        }

        const raw = result.response.text();
        const cleaned = cleanGeminiJson(raw);
        if (!raw || cleaned.trim() === '') {
             console.error("Gemini returned empty or whitespace-only content after cleaning.");
             console.error("Gemini Raw Output (before cleaning):", raw);
             return {
                name: 'Empty AI Response',
                email: extractedEmail || `empty_ai_response_${uuidv4()}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: 'Gemini returned empty content.',
                skills: [],
                experienceYears: 0,
                jobTitle: 'Empty Response',
                education: 'N/A',
            };
        }

        try {
            const parsed = JSON.parse(cleaned);
            return {
                name: parsed.name || 'N/A',
                email: extractedEmail || parsed.email || 'N/A',
                phone: parsed.phone || 'N/A',
                location: parsed.location || 'N/A',
                score: parsed.score || 0,
                parsedText: parsed.parsedText || 'No summary provided.',
                skills: parsed.skills || [],
                experienceYears: parsed.experienceYears || 0,
                jobTitle: parsed.jobTitle || 'N/A',
                education: parsed.education || 'N/A',
             };
        } catch (jsonParseError) {
             console.error('Failed to parse Gemini output as JSON:', jsonParseError);
             console.error('Raw output causing JSON parse error (partial):', cleaned.substring(0, 500) + '...');
             return {
                 name: 'JSON Parse Failed',
                email: extractedEmail || `json_parse_failed_${uuidv4()}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: `Failed to parse Gemini output as JSON: ${jsonParseError.message}. Raw (partial): ${cleaned.substring(0, 200)}...`,
                skills: [],
                experienceYears: 0,
                jobTitle: 'JSON Parse Failed',
                education: 'N/A',
             };
        }
    } catch (error) {
        console.error('Gemini parsing failed with API error:', error.message, error);
         if (error instanceof Error && error.message.includes('safety ratings')) {
             console.error('Gemini blocked content due to safety ratings.');
             return {
                 name: 'Content Blocked',
                email: extractedEmail || `content_blocked_${uuidv4()}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: 'Gemini blocked the resume content due to safety policy violation.',
                skills: [],
                experienceYears: 0,
                jobTitle: 'Content Blocked',
                education: 'N/A',
             };
         }
        return {
             name: 'Parsing Failed',
            email: extractedEmail || `parsing_failed_${uuidv4()}@example.com`,
            phone: 'N/A',
            location: 'N/A',
            score: 0,
            parsedText: `Automatic parsing failed: ${error.message}.`,
            skills: [],
            experienceYears: 0,
            jobTitle: 'Parsing Failed',
            education: 'N/A',
        };
    }
};

const uploadToFirebaseStorage = async (filePath, filename, candidateId) => {
    try {
        const originalFileName = filename || `resume-${candidateId}.pdf`;
        const sanitizedFileName = originalFileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const uniqueFileName = `Resume/${candidateId}_${Date.now()}_${sanitizedFileName}`;
        const fileRef = bucket.file(uniqueFileName);
        console.log(`Attempting to upload ${filename} (from ${filePath}) to gs://${bucket.name}/${uniqueFileName}`);

        const uploadStream = fileRef.createWriteStream({
             metadata: {
                 contentType: 'application/pdf',
             },
             public: true
        });

        await new Promise((resolve, reject) => {
             const readStream = nodeFs.createReadStream(filePath);
             readStream.pipe(uploadStream)
                 .on('error', reject)
                 .on('finish', resolve);
        });

         const downloadURL = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(uniqueFileName)}`;
        console.log(`Successfully uploaded to: ${downloadURL}`);
        return downloadURL;
    } catch (error) {
        console.error(`Error uploading file ${filename} to Firebase Storage:`, error);
        throw new Error(`Failed to upload file '${filename}' to Firebase Storage: ${error.message}`);
    }
};

const saveCandidateToRealtimeDatabase = async (candidate) => {
    try {
        if (candidate.name === 'API Key Missing') {
             console.warn(`Saving candidate ${candidate.id} with API key error status.`);
        }

        const candidateRef = database.ref(`talent_pool/${candidate.id}`);
        const dataToSave = {
            id: candidate.id,
            name: candidate.name,
            email: candidate.email,
            phone: candidate.phone,
            location: candidate.location,
            score: candidate.score,
            parsedText: candidate.parsedText,
            skills: Array.isArray(candidate.skills) ? candidate.skills : [],
            experience: candidate.experience,
            jobTitle: candidate.jobTitle,
            education: candidate.education,
            approved: typeof candidate.approved === 'boolean' ? candidate.approved : false,
            resumeUrl: candidate.resumeUrl || 'N/A',
            processedAt: admin.database.ServerValue.TIMESTAMP
        };

         Object.keys(dataToSave).forEach(key => dataToSave[key] === undefined || dataToSave[key] === null ? delete dataToSave[key] : {});
        await candidateRef.set(dataToSave);
        console.log(`✅ Candidate ${candidate.id} saved successfully to DB`);
    } catch (error) {
        console.error(`❌ Error saving candidate ${candidate.id} to Realtime Database:`, error);
    }
};

async function processInBatches(items, batchSize, processBatchFn) {
    const results = [];
    const totalBatches = Math.ceil(items.length / batchSize);
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        console.log(`--- Starting batch ${Math.floor(i/batchSize) + 1}/${totalBatches} with ${batch.length} items ---`);
        const batchResults = await processBatchFn(batch);
        results.push(...batchResults);
        if (i + batchSize < items.length) {
             console.log(`--- Batch processed. Waiting 5 seconds before next batch... ---`);
             await delay(5000);
        }
    }
    return results;
}

const processResumeFiles = async (multerFiles, jobDescription, recruiterSuggestion) => {
     console.log(`Starting resume processing for ${multerFiles.length} file(s) received.`);
    if (!apiKey || admin.apps.length === 0 || !database || !bucket) {
        const reason = !apiKey ? "Gemini API Key is not configured." : "Firebase Admin SDK failed to initialize.";
        console.error(`Cannot process files: ${reason}`);
         const candidatesWithError = multerFiles.map(file => {
             const id = uuidv4();
             const candidate = validateCandidate({
                 id: id,
                name: reason.includes("Gemini") ? 'API Key Missing' : 'Service Error',
                email: `${reason.includes("Gemini") ? 'api_key_missing' : 'service_error'}_${id}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: `Processing skipped: ${reason} File: ${file.originalname}`,
                skills: [],
                experience: 0,
                jobTitle: 'Error',
                education: 'N/A',
                resumeUrl: `File received: ${file.originalname}`,
             });
             if (admin.apps.length > 0 && database) {
                 saveCandidateToRealtimeDatabase(candidate).catch(console.error);
             } else {
                 console.error(`Could not save error entry for ${file.originalname}: Firebase Database not initialized.`);
             }
             return candidate;
         });
         console.log(`Created error entries for all files due to: ${reason}`);
        return {
            success: false,
            totalProcessed: multerFiles.length,
            candidates: candidatesWithError,
            message: `Processing aborted: ${reason}`
        };
    }
    if (multerFiles.length === 0) {
         console.log("No files provided to process.");
        return {
            success: true,
            totalProcessed: 0,
            candidates: [],
            message: "No files were provided for processing."
        };
    }
     const pdfFiles = multerFiles.filter(file => file.mimetype === 'application/pdf');
    const nonPdfFiles = multerFiles.filter(file => file.mimetype !== 'application/pdf');
     if (nonPdfFiles.length > 0) {
         console.warn(`Skipping ${nonPdfFiles.length} non-PDF file entries.`);
         nonPdfFiles.forEach(file => {
             const id = uuidv4();
             const candidate = validateCandidate({
                 id: id,
                name: 'Invalid File Type',
                email: `invalid_type_${id}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: `Skipped processing due to invalid file type or data ('${file.originalname}', MIME: ${file.mimetype}). Only PDF files are supported.`,
                skills: [],
                experience: 0,
                jobTitle: 'N/A',
                education: 'N/A',
                resumeUrl: `File received: ${file.originalname}`,
             });
              saveCandidateToRealtimeDatabase(candidate).catch(console.error);
         });
     }
    if (pdfFiles.length === 0) {
         console.log("No valid PDF files found after filtering.");
        return {
             success: true,
             totalProcessed: multerFiles.length,
             validPdfProcessed: 0,
             invalidFilesSkipped: nonPdfFiles.length,
             candidates: [],
            message: "No valid PDF files were provided for processing."
        };
    }
     console.log(`Found ${pdfFiles.length} valid PDF files to process.`);
    const candidates = await processInBatches(
        pdfFiles,
        5,
        async (batch) => {
            const batchResults = [];
            for (const file of batch) {
                if (!file || !file.path || !file.originalname) {
                    console.warn(`Skipping invalid multer file entry in batch (unexpected).`);
                    continue;
                }
                const { path: filePath, originalname: filename } = file;
                console.log(`-> Processing file: ${filename} (Temp Path: ${filePath}, Size: ${file.size} bytes)`);
                let candidate = null;
                const id = uuidv4();
                try {
                    const text = await extractTextFromPdf(filePath, filename);
                    if (!text || text.trim().length < 50) {
                        console.warn(`Skipping file ${filename}: insufficient or invalid text content (${text?.length || 0} characters) after extraction.`);
                        candidate = validateCandidate({
                            id: id,
                            name: 'Insufficient Text',
                            email: `insufficient_text_${uuidv4()}@example.com`,
                            phone: 'N/A',
                            location: 'N/A',
                            score: 0,
                            parsedText: 'Could not extract enough text from the PDF, or the PDF format was unreadable.',
                            skills: [],
                            experience: 0,
                            jobTitle: 'N/A',
                            education: 'N/A',
                            resumeUrl: `File received: ${filename}`,
                         });
                         await saveCandidateToRealtimeDatabase(candidate);
                         batchResults.push(candidate);
                         console.log(`-> Skipped ${filename}, added insufficient text error entry.`);
                         continue;
                    }
                    console.log(`-> Sending text from ${filename} to Gemini...`);
                    const parsedCandidateData = await parseWithGemini(text, jobDescription, recruiterSuggestion);
                    candidate = validateCandidate({
                        ...parsedCandidateData,
                        id: id,
                         approved: false,
                         resumeUrl: 'N/A',
                    });
                    console.log(`-> Gemini parsing attempted for ${filename}. Result name: ${candidate.name}, Score: ${candidate.score}`);
                    const geminiErrorNames = ['API Key Missing', 'API No Response', 'Empty AI Response', 'JSON Parse Failed', 'Content Blocked', 'Parsing Failed'];
                    if (geminiErrorNames.includes(candidate.name)) {
                         console.warn(`-> Gemini returned a fatal error status for ${filename}: ${candidate.name}. Skipping upload.`);
                         await saveCandidateToRealtimeDatabase(candidate);
                         batchResults.push(candidate);
                         console.log(`-> Saved Gemini error candidate for ${filename}.`);
                         continue;
                    }
                    try {
                        const resumeUrl = await uploadToFirebaseStorage(filePath, filename, id);
                        candidate.resumeUrl = resumeUrl;
                        console.log(`-> Uploaded ${filename}. URL: ${resumeUrl}`);
                    } catch (uploadError) {
                        console.error(`-> Failed to upload ${filename} to storage:`, uploadError);
                        candidate.resumeUrl = 'Upload Failed';
                         candidate.parsedText = `${candidate.parsedText}\n\nNote: Failed to upload resume file: ${uploadError.message.substring(0, Math.min(uploadError.message.length, 200))}...`;
                    }
                    await saveCandidateToRealtimeDatabase(candidate);
                    batchResults.push(candidate);
                    console.log(`-> Finished processing and saving candidate from ${filename}`);
                } catch (err) {
                    const errorMessage = err.message || 'An unexpected error occurred during file processing.';
                    console.error(`-> Error processing file ${filename}:`, errorMessage);
                    const errorCandidate = validateCandidate({
                        id: id,
                        name: candidate && candidate.name !== 'N/A' && candidate.name !== 'Processing Error' && !geminiErrorNames.includes(candidate.name) ? candidate.name : 'Processing Error',
                        email: candidate && candidate.email !== 'N/A' && !candidate.email.startsWith('processing_error_') ? candidate.email : `processing_error_${uuidv4()}@example.com`,
                        phone: candidate ? candidate.phone : 'N/A',
                        location: candidate ? candidate.location : 'N/A',
                        score: 0,
                        parsedText: candidate && candidate.parsedText && candidate.parsedText !== 'No summary provided.' ? `An error occurred during processing: ${errorMessage}\n\nOriginal summary: ${candidate.parsedText}` : `An error occurred during processing this file ('${filename}'): ${errorMessage}`,
                        skills: candidate ? candidate.skills : [],
                        experience: candidate ? candidate.experience : 0,
                        jobTitle: candidate && candidate.jobTitle !== 'N/A' && candidate.jobTitle !== 'Error' && !geminiErrorNames.includes(candidate.jobTitle) ? candidate.jobTitle : 'Error',
                        education: candidate ? candidate.education : 'N/A',
                        approved: false,
                        resumeUrl: candidate && candidate.resumeUrl && candidate.resumeUrl !== 'N/A' && candidate.resumeUrl !== 'Upload Failed' ? candidate.resumeUrl : 'Processing Failed',
                    });
                    await saveCandidateToRealtimeDatabase(errorCandidate);
                    batchResults.push(errorCandidate);
                    console.log(`-> Added general error candidate from ${filename} to batch results.`);
                } finally {
                    try {
                         await fs.access(filePath);
                         await fs.unlink(filePath);
                    } catch (cleanupErr) {
                         if (cleanupErr.code !== 'ENOENT') {
                            console.error(`Error cleaning up temp file ${filePath} in individual file finally block:`, cleanupErr);
                         }
                    }
                }
            }
            return batchResults;
        }
    );
    const sortedCandidates = candidates.sort((a, b) => b.score - a.score);
    console.log(`\n--- Finished processing ${candidates.length} valid PDF file(s). ---\n`);
    return {
        success: true,
        totalProcessed: multerFiles.length,
        validPdfProcessed: candidates.length,
        invalidFilesSkipped: nonPdfFiles.length,
        candidates: sortedCandidates,
        message: "Processing complete."
    };
};

// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors({
  origin: 'https://www.jobformautomator.com',
  methods: ['GET', 'POST'], // Specify allowed methods (adjust as needed)
  allowedHeaders: ['Content-Type'], // Specify allowed headers (adjust as needed)
  credentials: true, // Enable if your frontend sends credentials (e.g., cookies)
}));

// Configure multer for single file upload
const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 10 * 1024 * 1024, // Limit file size to 10MB per file
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.originalname}. Only PDF files are allowed.`), false);
    }
  },
});

// Multer error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: `File too large: ${err.field}. Maximum size is 10MB.`,
      });
    }
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  } else if (err) {
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }
  next();
});

// API Route for Resume Parsing
app.post('/parse-resumes', upload.single('file'), async (req, res) => {
    console.log('POST request received to /parse-resumes');
    const tempFile = req.file;
    const jobDescription = req.body.jd || '';
    const recruiterSuggestion = req.body.rs || '';

    try {
        if (!tempFile) {
            console.log("No file received in the request.");
            return res.status(400).json({
                success: false,
                error: "No file uploaded. Please upload a PDF file with the field name 'file'.",
            });
        }

        console.log(`Received file: ${tempFile.originalname}`);
        console.log("JD (partial):", jobDescription.substring(0, Math.min(jobDescription.length, 100)) + (jobDescription.length > 100 ? '...' : ''));
        console.log("RS (partial):", recruiterSuggestion.substring(0, Math.min(recruiterSuggestion.length, 100)) + (recruiterSuggestion.length > 100 ? '...' : ''));

        if (!apiKey || admin.apps.length === 0 || !database || !bucket) {
            const reason = !apiKey ? "Gemini API Key is not configured." : "Firebase Admin SDK failed to initialize.";
            console.error(`Cannot process file: ${reason}`);
            const id = uuidv4();
            const candidate = validateCandidate({
                id: id,
                name: reason.includes("Gemini") ? 'API Key Missing' : 'Service Error',
                email: `${reason.includes("Gemini") ? 'api_key_missing' : 'service_error'}_${id}@example.com`,
                phone: 'N/A',
                location: 'N/A',
                score: 0,
                parsedText: `Processing skipped: ${reason} File: ${tempFile.originalname}`,
                skills: [],
                experience: 0,
                jobTitle: 'Error',
                education: 'N/A',
                resumeUrl: `File received: ${tempFile.originalname}`,
            });
            await saveCandidateToRealtimeDatabase(candidate);
            return res.status(400).json({
                success: false,
                candidate,
                error: reason,
            });
        }

        // Call processResumeFiles with a single-item array to reuse existing logic
        const results = await processResumeFiles([tempFile], jobDescription, recruiterSuggestion);
        const candidate = results.candidates[0] || null;

        if (!candidate) {
            return res.status(500).json({
                success: false,
                error: "Failed to process file: No candidate data returned.",
            });
        }

        res.status(200).json({
            success: true,
            candidate,
        });

    } catch (error) {
        const errorMessage = error.message || 'Unexpected error during processing.';
        console.error('[Overall Request Error]', errorMessage, error);
        if (tempFile && tempFile.path) {
            try {
                await fs.access(tempFile.path);
                await fs.unlink(tempFile.path);
                console.log(`Cleaned up temp file: ${tempFile.path}`);
            } catch (cleanupErr) {
                if (cleanupErr.code !== 'ENOENT') {
                    console.error(`Error cleaning up temp file ${tempFile.path} in overall catch block:`, cleanupErr);
                }
            }
        }
        res.status(500).json({
            success: false,
            error: errorMessage,
        });
    }
});

app.post("/", (req, res) => {
    return res.send({message: "hello from parse resume"});
});

// Start the Express Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Resume parsing endpoint: POST http://localhost:${PORT}/parse-resumes`);
});