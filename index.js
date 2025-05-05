// server.js

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
console.log('GOOGLE_APPLICATION_CREDENTIALS is set to:', process.env.GOOGLE_APPLICATION_CREDENTIALS ? '[Set]' : '[Not Set]');

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
            apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
            authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
            databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
            projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
            storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
            messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
            appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
            measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
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
// ADAPTED TO WORK WITH MULTER'S TEMPORARY FILE PATH - Logic remains the same
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
                                 // Fallback to raw text if decoding fails
                                // console.warn(`Failed to decode text chunk in ${filename}:`, text.R[0].T, decodeError);
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

// --- Gemini Helper Functions (These remain the same) ---
const cleanGeminiJson = (raw) => {
    let cleaned = raw.trim();
    // Remove leading and trailing markdown code block fences
    // More robust check for starting fence
    if (cleaned.startsWith('```json')) {
        const codeBlockEnd = cleaned.indexOf('```', 7); // Search for closing fence after ```json
         if (codeBlockEnd !== -1) {
            // Extract content between ```json and ```
             cleaned = cleaned.substring(7, codeBlockEnd).trim();
         } else {
            // If no closing fence, remove only the leading ```json
             cleaned = cleaned.substring(7).trim();
         }
    } else if (cleaned.startsWith('```')) { // Handle generic ```
         const codeBlockEnd = cleaned.indexOf('```', 3); // Search for closing fence after ```
         if (codeBlockEnd !== -1) {
             // Extract content between ``` and ```
              cleaned = cleaned.substring(3, codeBlockEnd).trim();
         } else {
              // If no closing fence, remove only the leading ```
              cleaned = cleaned.substring(3).trim();
         }
    }

    // Attempt to remove leading/trailing non-JSON characters more robustly
    // Find the first { and the last } to isolate the JSON string
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
    } else {
        console.warn("Could not find valid JSON structure ({...}) within cleaned Gemini output (partial):", cleaned.substring(0, 200) + '...'); // Log partial output if structure not found
         // As a fallback, just return the cleaned text, JSON.parse will likely fail
    }

    return cleaned;
};


// Using a generic object shape similar to Candidate, but without the TS type
const validateCandidate = (candidateData) => {
    // Ensure candidateData is an object
    candidateData = candidateData || {};

    // Normalize email to lowercase before validation
    const emailInput = candidateData.email && typeof candidateData.email === 'string' ? candidateData.email.trim().toLowerCase() : '';
    // Use case-insensitive regex for email validation
    const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
     // Fallback email based on name if extraction fails
     const fallbackEmailFromName = candidateData.name && typeof candidateData.name === 'string' && candidateData.name.trim() !== '' && candidateData.name.trim().toLowerCase() !== 'n/a'
        ? `${candidateData.name.trim().replace(/\s+/g, "").toLocaleLowerCase()}@gmail.com`
        : `unknown_${uuidv4()}@gmail.com`; // Use uuid for unique fallback if name is also bad

    const email = emailInput && emailRegex.test(emailInput)
        ? emailInput
        : fallbackEmailFromName;

    return {
        // Use provided data or fallback defaults
        id: candidateData.id || uuidv4(), // Assign ID if not already present
        name: candidateData.name && typeof candidateData.name === 'string' && candidateData.name.trim() !== '' && candidateData.name.trim().toLowerCase() !== 'n/a' ? candidateData.name.trim() : 'Unknown',
        email: email,
        phone: candidateData.phone && typeof candidateData.phone === 'string' && candidateData.phone.trim() !== '' && candidateData.phone.trim().toLowerCase() !== 'n/a' ? candidateData.phone.trim() : 'N/A',
        location: candidateData.location && typeof candidateData.location === 'string' && candidateData.location.trim() !== '' && candidateData.location.trim().toLowerCase() !== 'n/a' ? candidateData.location.trim() : 'N/A',
        score: typeof candidateData.score === 'number' ? Math.max(0, Math.min(100, Math.round(candidateData.score))) : 0,
        parsedText: candidateData.parsedText && typeof candidateData.parsedText === 'string' && candidateData.parsedText.trim() ? candidateData.parsedText.trim() : 'No summary provided.',
        skills: Array.isArray(candidateData.skills) ? candidateData.skills.filter(s => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : [],
        // Gemini returns experienceYears, map it to 'experience' property
        experience: typeof candidateData.experienceYears === 'number' && candidateData.experienceYears >= 0 ? Math.round(candidateData.experienceYears) : 0,
        jobTitle: candidateData.jobTitle && typeof candidateData.jobTitle === 'string' && candidateData.jobTitle.trim() !== '' && candidateData.jobTitle.trim().toLowerCase() !== 'n/a' ? candidateData.jobTitle.trim() : 'N/A',
        education: candidateData.education && typeof candidateData.education === 'string' && candidateData.education.trim() !== '' && candidateData.education.trim().toLowerCase() !== 'n/a' ? candidateData.education.trim() : 'N/A',
        approved: typeof candidateData.approved === 'boolean' ? candidateData.approved : false,
        resumeUrl: candidateData.resumeUrl || 'N/A', // Default resumeUrl
    };
};


// --- Extract Email from Text (Remains the same) ---
const extractEmailFromText = (text) => {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
    const matches = text.match(emailRegex);
    return matches && matches.length > 0 ? matches[0].toLowerCase() : null;
};


// --- Parse With Gemini (Remains largely the same, uses apiKey variable) ---
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
        // Note: We already checked for API key at the start of processResumeFiles
        // but returning a specific error structure here is still good practice
        if (!apiKey) {
             console.error("Gemini API key is not configured within parseWithGemini. Skipping Gemini call.");
             return {
                name: 'API Key Missing',
                email: `api_key_missing_${uuidv4()}@example.com`, // Ensure unique email
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

        // Extract email from text as a fallback before sending to Gemini
        const extractedEmail = extractEmailFromText(text);
        // console.log(`Extracted email from text: ${extractedEmail || 'None'}`); // Avoid excessive logs

        // Truncate text if too long to avoid token limits (using generous estimates for Gemini 1.5 Flash)
        const SAFETY_MARGIN_TOKENS = 5000; // Added margin for safety
        // Estimate prompt tokens - rough heuristic (chars / 4)
        const approxPromptTokens = Math.ceil((prompt.length + jobDescription.length + recruiterSuggestion.length) / 4);
        // Max tokens for the text, leaving space for prompt and safety margin
        const MAX_TEXT_TOKENS = 1000000 - approxPromptTokens - SAFETY_MARGIN_TOKENS; // Gemini 1.5 Flash context window is large
        // Max characters for the text (using an average char-per-token ratio like 3)
        const MAX_TEXT_CHARS = MAX_TEXT_TOKENS * 3;

        let textForGemini = text;
        if (text.length > MAX_TEXT_CHARS) {
            console.warn(`Resume text length (${text.length} chars) exceeds approximate limit (${MAX_TEXT_CHARS} chars). Truncating resume text for prompt.`);
            textForGemini = text.substring(0, MAX_TEXT_CHARS);
        } else {
            // console.log(`Resume text length (${text.length} chars) is within approximate limit.`); // Avoid excessive logs
        }

        // console.log("Attempting Gemini generateContent call..."); // Avoid excessive logs
        // Ensure genAI is initialized with an API key
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-001"});

        // Embed text correctly within the markdown block for Gemini
        // Using template literals correctly here:
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


        const result = await model.generateContent(promptWithText);

        // Check for expected response structure
        if (!result || !result.response || typeof result.response.text !== 'function') {
             console.error("Gemini API returned an unexpected empty result or response format.");
             return { // Return a structure similar to what validateCandidate expects for an error
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

        // console.log("Gemini Raw Output (partial):", raw.length <= 500 ? raw : raw.substring(0, 500) + '...'); // Avoid excessive logs
        // console.log("Gemini Cleaned Output (partial):", cleaned.length <= 500 ? cleaned : cleaned.substring(0, 500) + '...'); // Avoid excessive logs

        if (!raw || cleaned.trim() === '') {
             console.error("Gemini returned empty or whitespace-only content after cleaning.");
             console.error("Gemini Raw Output (before cleaning):", raw);
             return { // Return a structure similar to what validateCandidate expects for an error
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
            // Return the parsed data. validateCandidate will be called next.
            return {
                name: parsed.name || 'N/A',
                // Prioritize extracted email, fallback to parsed, then N/A
                email: extractedEmail || parsed.email || 'N/A',
                phone: parsed.phone || 'N/A',
                location: parsed.location || 'N/A',
                score: parsed.score || 0,
                parsedText: parsed.parsedText || 'No summary provided.',
                skills: parsed.skills || [],
                experienceYears: parsed.experienceYears || 0, // Ensure this matches the output format
                jobTitle: parsed.jobTitle || 'N/A',
                education: parsed.education || 'N/A',
             };
        } catch (jsonParseError) {
             console.error('Failed to parse Gemini output as JSON:', jsonParseError);
             console.error('Raw output causing JSON parse error (partial):', cleaned.substring(0, 500) + '...');
             return { // Return a structure similar to what validateCandidate expects for an error
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
             return { // Return a structure similar to what validateCandidate expects for an error
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

        // Return a structure similar to what validateCandidate expects for other errors
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


// --- Firebase Storage Upload (using firebase-admin) ---
// ADAPTED TO WORK WITH MULTER'S TEMPORARY FILE PATH
const uploadToFirebaseStorage = async (filePath, filename, candidateId) => {
    try {
        const originalFileName = filename || `resume-${candidateId}.pdf`;
        // Sanitize filename for storage paths - keep dots but remove other invalid chars
        const sanitizedFileName = originalFileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const uniqueFileName = `resume/${candidateId}_${Date.now()}_${sanitizedFileName}`; // Store in a 'resumes' folder

        const fileRef = bucket.file(uniqueFileName);
        console.log(`Attempting to upload ${filename} (from ${filePath}) to gs://${bucket.name}/${uniqueFileName}`);

        // Upload the file directly from its temporary path using createReadStream
        const uploadStream = fileRef.createWriteStream({
             metadata: {
                 contentType: 'application/pdf', // Assuming PDF
             },
             public: true // Make file public (adjust based on security)
        });

        // Pipe the temporary file's content to the Firebase Storage upload stream
        await new Promise((resolve, reject) => {
             // Use nodeFs for createReadStream
             const readStream = nodeFs.createReadStream(filePath);
             readStream.pipe(uploadStream)
                 .on('error', reject)
                 .on('finish', resolve);
        });


        // If public: true, the URL is often predictable
         const downloadURL = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(uniqueFileName)}`;

         // Alternative (more secure for private files): generate a signed URL
         // const [downloadURL] = await fileRef.getSignedUrl({
         //    action: 'read',
         //    expires: '03-01-2500', // Set a far future expiration date for semi-permanent links
         // });

        console.log(`Successfully uploaded to: ${downloadURL}`);
        return downloadURL;
    } catch (error) {
        console.error(`Error uploading file ${filename} to Firebase Storage:`, error);
        // Re-throw the error so the processing loop can catch it for this file
        throw new Error(`Failed to upload file '${filename}' to Firebase Storage: ${error.message}`);
    }
};

// --- Firebase Realtime Database Save (Remains the same) ---
const saveCandidateToRealtimeDatabase = async (candidate) => {
    try {
        // Check for specific error states before saving, though original code saved them anyway.
        // Keeping the check but allowing save for logging purposes.
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
            // Ensure skills is an array, even if empty
            skills: Array.isArray(candidate.skills) ? candidate.skills : [],
            experience: candidate.experience,
            jobTitle: candidate.jobTitle,
            education: candidate.education,
            approved: typeof candidate.approved === 'boolean' ? candidate.approved : false, // Ensure approved is boolean
            resumeUrl: candidate.resumeUrl || 'N/A', // Ensure resumeUrl exists
             // Add timestamp for when it was processed
            processedAt: admin.database.ServerValue.TIMESTAMP
        };

         // Remove undefined or null values before saving (optional but good practice)
         Object.keys(dataToSave).forEach(key => dataToSave[key] === undefined || dataToSave[key] === null ? delete dataToSave[key] : {});


        await candidateRef.set(dataToSave);
        console.log(`✅ Candidate ${candidate.id} saved successfully to DB`);
    } catch (error) {
        console.error(`❌ Error saving candidate ${candidate.id} to Realtime Database:`, error);
        // Allow processing to continue for other files even if saving one fails
    }
};

// --- Batch Processing Helper (Remains the same) ---
async function processInBatches(items, batchSize, processBatchFn) {
    const results = [];
    const totalBatches = Math.ceil(items.length / batchSize);
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        console.log(`--- Starting batch ${Math.floor(i/batchSize) + 1}/${totalBatches} with ${batch.length} items ---`);
        const batchResults = await processBatchFn(batch);
        results.push(...batchResults);

        // Add delay only if there are more batches to process
        if (i + batchSize < items.length) {
             console.log(`--- Batch processed. Waiting 5 seconds before next batch... ---`);
             await delay(5000); // Delay between batches
        }
    }
    return results;
}


// --- Main Processing Logic (Adapted to work with multer files) ---
// This function now takes the file objects provided by multer
const processResumeFiles = async (multerFiles, jobDescription, recruiterSuggestion) => {
     console.log(`Starting resume processing for ${multerFiles.length} file(s) received.`);

    // --- Check for API Key BEFORE starting file processing batches ---
    // Also, check if Firebase Admin is actually initialized before proceeding
    // The init block above should exit on fatal error, but checking here adds safety
    if (!apiKey || admin.apps.length === 0 || !database || !bucket) {
        const reason = !apiKey ? "Gemini API Key is not configured." : "Firebase Admin SDK failed to initialize.";
        console.error(`Cannot process files: ${reason}`);

         // Create error entries for all files
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
             // Attempt to save error entries immediately (best effort)
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
            candidates: candidatesWithError, // Return the error candidates
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

     // Filter for only PDF files initially
    const pdfFiles = multerFiles.filter(file => file.mimetype === 'application/pdf');
    const nonPdfFiles = multerFiles.filter(file => file.mimetype !== 'application/pdf');

     if (nonPdfFiles.length > 0) {
         console.warn(`Skipping ${nonPdfFiles.length} non-PDF file entries.`);
         // Create error entries for non-PDF files and save them
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
                resumeUrl: `File received: ${file.originalname}`, // Log filename received
             });
              saveCandidateToRealtimeDatabase(candidate).catch(console.error); // Save error entry
         });
     }


    if (pdfFiles.length === 0) {
         console.log("No valid PDF files found after filtering.");
        return {
             success: true,
             totalProcessed: multerFiles.length, // Total files attempted (includes invalid types)
             validPdfProcessed: 0,
             invalidFilesSkipped: nonPdfFiles.length,
             candidates: [], // Only return results for successfully processed PDFs
            message: "No valid PDF files were provided for processing."
        };
    }

     console.log(`Found ${pdfFiles.length} valid PDF files to process.`);

    const candidates = await processInBatches(
        pdfFiles, // Process only the valid PDF files
        5, // Process 5 files at a time
        async (batch) => {
            const batchResults = [];
            // console.log(`Processing batch of ${batch.length} file objects...`); // Logged in processInBatches

            for (const file of batch) { // 'file' here is a multer file object
                if (!file || !file.path || !file.originalname) {
                    console.warn(`Skipping invalid multer file entry in batch (unexpected).`);
                    continue;
                }

                const { path: filePath, originalname: filename } = file; // Extract path and originalname
                console.log(`-> Processing file: ${filename} (Temp Path: ${filePath}, Size: ${file.size} bytes)`);

                let candidate = null; // Placeholder for candidate data
                const id = uuidv4(); // Generate ID early for this file

                try {
                    // Use the filePath provided by multer
                    const text = await extractTextFromPdf(filePath, filename);

                    if (!text || text.trim().length < 50) {
                        console.warn(`Skipping file ${filename}: insufficient or invalid text content (${text?.length || 0} characters) after extraction.`);
                        // Create and save an error candidate for insufficient text
                        candidate = validateCandidate({ // Use validateCandidate to ensure structure
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
                            resumeUrl: `File received: ${filename}`, // Log filename
                         });
                         await saveCandidateToRealtimeDatabase(candidate); // Save error entry
                         batchResults.push(candidate);
                         console.log(`-> Skipped ${filename}, added insufficient text error entry.`);
                         continue; // Move to the next file in the batch
                    }
                    // console.log(`Text extracted (${text.length} chars) from ${filename}.`); // Avoid excessive logs

                    console.log(`-> Sending text from ${filename} to Gemini...`);
                    const parsedCandidateData = await parseWithGemini(text, jobDescription, recruiterSuggestion);

                    // Combine Gemini data with ID and initial status/url
                    candidate = validateCandidate({
                        ...parsedCandidateData, // Includes name, email, score, parsedText, etc.
                        id: id, // Use the pre-generated ID for this file
                         approved: false, // Default status
                         resumeUrl: 'N/A', // Placeholder until upload
                    });
                    console.log(`-> Gemini parsing attempted for ${filename}. Result name: ${candidate.name}, Score: ${candidate.score}`);

                    // Check if Gemini returned a specific fatal error status before attempting upload/save
                    const geminiErrorNames = ['API Key Missing', 'API No Response', 'Empty AI Response', 'JSON Parse Failed', 'Content Blocked', 'Parsing Failed'];
                    if (geminiErrorNames.includes(candidate.name)) {
                         console.warn(`-> Gemini returned a fatal error status for ${filename}: ${candidate.name}. Skipping upload.`);
                         // The error candidate object structure is already created and validated.
                         // Save this error candidate object to DB.
                         await saveCandidateToRealtimeDatabase(candidate);
                         batchResults.push(candidate);
                         console.log(`-> Saved Gemini error candidate for ${filename}.`);
                         continue; // Move to the next file in the batch
                    }

                    // Attempt upload if Gemini parsing was successful (not a fatal error)
                    try {
                         // Use the filePath provided by multer for upload
                        const resumeUrl = await uploadToFirebaseStorage(filePath, filename, id);
                        candidate.resumeUrl = resumeUrl; // Update the candidate object with the URL
                        console.log(`-> Uploaded ${filename}. URL: ${resumeUrl}`);
                    } catch (uploadError) {
                        console.error(`-> Failed to upload ${filename} to storage:`, uploadError);
                        candidate.resumeUrl = 'Upload Failed'; // Record failure in the candidate object
                         // Append upload error to parsedText for visibility in the DB
                         candidate.parsedText = `${candidate.parsedText}\n\nNote: Failed to upload resume file: ${uploadError.message.substring(0, Math.min(uploadError.message.length, 200))}...`; // Limit error message length
                    }

                    // Save the candidate data (including the resumeUrl, whether successful or failed)
                    await saveCandidateToRealtimeDatabase(candidate);
                    batchResults.push(candidate); // Add to batch results regardless of upload success

                    console.log(`-> Finished processing and saving candidate from ${filename}`);

                } catch (err) {
                    // Catch errors during extraction (e.g., corrupted PDF), or any other unexpected errors *for this specific file*
                    const errorMessage = err.message || 'An unexpected error occurred during file processing.';
                    console.error(`-> Error processing file ${filename}:`, errorMessage);

                    // Create or update candidate object with error details using validateCandidate
                    // If 'candidate' object was already partially created (e.g., text extraction worked)
                    // try to preserve some of that partial info like name/email/etc.
                    const errorCandidate = validateCandidate({
                        id: id, // Use the pre-generated ID
                        name: candidate && candidate.name !== 'N/A' && candidate.name !== 'Processing Error' && !geminiErrorNames.includes(candidate.name) ? candidate.name : 'Processing Error', // Preserve name if available and not a Gemini error name
                        // Preserve email if available, otherwise generate unique error email
                        email: candidate && candidate.email !== 'N/A' && !candidate.email.startsWith('processing_error_') ? candidate.email : `processing_error_${uuidv4()}@example.com`,
                        phone: candidate ? candidate.phone : 'N/A',
                        location: candidate ? candidate.location : 'N/A',
                        score: 0, // Reset score on error
                        // Combine error message with any existing parsedText
                        parsedText: candidate && candidate.parsedText && candidate.parsedText !== 'No summary provided.' ? `An error occurred during processing: ${errorMessage}\n\nOriginal summary: ${candidate.parsedText}` : `An error occurred during processing this file ('${filename}'): ${errorMessage}`,
                        skills: candidate ? candidate.skills : [], // Keep skills if extracted
                        experience: candidate ? candidate.experience : 0, // Keep experience if extracted
                        jobTitle: candidate && candidate.jobTitle !== 'N/A' && candidate.jobTitle !== 'Error' && !geminiErrorNames.includes(candidate.jobTitle) ? candidate.jobTitle : 'Error', // Preserve job title if extracted and not a Gemini error name
                        education: candidate ? candidate.education : 'N/A', // Keep education if extracted
                        approved: false, // Always false on error
                        // Preserve resumeUrl if upload somehow finished before another error, else mark as failed/processing failed
                        resumeUrl: candidate && candidate.resumeUrl && candidate.resumeUrl !== 'N/A' && candidate.resumeUrl !== 'Upload Failed' ? candidate.resumeUrl : 'Processing Failed',
                    });

                    await saveCandidateToRealtimeDatabase(errorCandidate);
                    batchResults.push(errorCandidate);
                    console.log(`-> Added general error candidate from ${filename} to batch results.`);
                } finally {
                    // Clean up the temporary file *immediately* after processing each file in the batch
                    // This prevents temp files from piling up if a batch takes a long time
                    try {
                         await fs.access(filePath); // Check if file exists before trying to delete
                         await fs.unlink(filePath);
                        // console.log(`Cleaned up temp file after processing: ${filePath}`); // Avoid excessive logs
                    } catch (cleanupErr) {
                         if (cleanupErr.code !== 'ENOENT') {
                            console.error(`Error cleaning up temp file ${filePath} in individual file finally block:`, cleanupErr);
                         }
                    }
                }
            }

             // Delay is handled by processInBatches helper

            return batchResults; // Return results for this batch
        }
    );

    // Sort candidates by score
    const sortedCandidates = candidates.sort((a, b) => b.score - a.score);

    console.log(`\n--- Finished processing ${candidates.length} valid PDF file(s). ---\n`);

    return {
        success: true, // Indicate the overall process completed without crashing
        totalProcessed: multerFiles.length, // Total files received by Multer
        validPdfProcessed: candidates.length, // How many PDFs went through the pipeline (success or error within batch)
        invalidFilesSkipped: nonPdfFiles.length, // How many invalid files were skipped
        candidates: sortedCandidates, // Return the detailed results for valid PDFs (includes errors)
        message: "Processing complete."
    };
};


// --- Express App Setup ---
const app = express();
const PORT = process.env.PORT || 3001; // Use a port, e.g., 3001
app.use(cors())

// Configure multer for file uploads
// Use memory storage to get a Buffer directly (alternative approach, slightly different cleanup)
// OR continue using disk storage (as we did), which is generally better for large files.
// Sticking with disk storage as it aligns with the pdf2json approach.
const upload = multer({
  dest: os.tmpdir(), // Use the system's temporary directory
  limits: {
    fileSize: 10 * 1024 * 1024, // Limit file size to 10MB per file
    files: 20 // Limit the number of files in one request
  },
  // Optional: fileFilter function to accept only specific mimetypes (e.g., PDF)
  // fileFilter: (req, file, cb) => {
  //   if (file.mimetype === 'application/pdf') {
  //     cb(null, true); // Accept the file
  //   } else {
  //     // Reject the file with an error
  //     cb(new Error(`Invalid file type: ${file.originalname}. Only PDF files are allowed.`), false);
  //   }
  // }
});


// --- API Route for Resume Parsing ---
// Use upload.array('file') to handle multiple files with the field name 'file'
// Multer will save files to os.tmpdir() and add req.files and req.body
app.post('/parse-resumes', upload.array('file'), async (req, res) => {
     console.log('POST request received to /parse-resumes');

    // Multer file objects are available in req.files
    const tempFiles = req.files || [];
    const jobDescription = req.body.jd || ''; // Get JD from form body
    const recruiterSuggestion = req.body.rs || ''; // Get RS from form body

    // Removed the batch cleanup function from the finally block here.
    // Cleanup is now done for *each file* immediately after it's processed in the batch loop.
    // This is more robust as temp files are removed sooner.

    try {
         if (!tempFiles || tempFiles.length === 0) {
             console.log("No files received in the request.");
             // No temp files to cleanup from multer if req.files is empty
             return res.status(400).json({
                 success: false,
                 message: "No files uploaded. Please upload one or more PDF files with the field name 'file'.",
                 totalProcessed: 0,
                 candidates: []
             });
         }

        console.log(`Received ${tempFiles.length} file(s) via multer.`);
        console.log("JD (partial):", jobDescription.substring(0, Math.min(jobDescription.length, 100)) + (jobDescription.length > 100 ? '...' : ''));
        console.log("RS (partial):", recruiterSuggestion.substring(0, Math.min(recruiterSuggestion.length, 100)) + (recruiterSuggestion.length > 100 ? '...' : ''));


        // Call the main processing function with multer file objects
        const results = await processResumeFiles(tempFiles, jobDescription, recruiterSuggestion);

        // Send the final response
        res.status(200).json(results);

    } catch (error) {
        // This catch block handles unexpected errors *during the overall request processing*
        // (e.g., errors in Express itself, or errors before the processing loop starts).
        // Errors *within* processing a single file are handled inside processResumeFiles.
        const errorMessage = error.message || 'An unknown overall error occurred during processing the upload.';
        console.error('[Overall Request Error]', errorMessage, error);

         // Attempt cleanup of any temp files that *might* still exist from multer if an overall error occurred early
         // (though the per-file cleanup in the batch loop is the primary mechanism).
         for (const file of tempFiles) {
             try {
                  await fs.access(file.path);
                  await fs.unlink(file.path);
             } catch (cleanupErr) {
                  if (cleanupErr.code !== 'ENOENT') {
                     console.error(`Error cleaning up temp file ${file.path} in overall catch block:`, cleanupErr);
                  }
             }
         }


        res.status(500).json({
            success: false,
            error: errorMessage,
            totalProcessed: tempFiles.length,
             validPdfProcessed: 0,
             invalidFilesSkipped: tempFiles.length,
            candidates: [], // Don't return partial results on overall error
        });
    }
    // Removed the finally block here as per-file cleanup is more reliable.
    // Global cleanup in finally could be used if per-file cleanup wasn't implemented.
    // The updated code cleans up each temp file right after it's processed in the batch.
});


// --- Start the Express Server ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Resume parsing endpoint: POST http://localhost:${PORT}/parse-resumes`);
});