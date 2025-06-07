const express = require('express');
const multer = require('multer');
const fs = require('fs'); // Standard fs for streams
const fsPromises = require('fs').promises; // Promises API for async file operations
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdf = require('pdf-parse');
const admin = require('firebase-admin');
const {
    ServicePrincipalCredentials,
    PDFServices,
    MimeType,
    ExtractPDFParams,
    ExtractElementType,
    ExtractPDFJob,
    ExtractPDFResult,
    SDKError,
    ServiceUsageError,
    ServiceApiError
} = require('@adobe/pdfservices-node-sdk');
const unzipper = require('unzipper');
require('dotenv').config();

// Firebase Initialization
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

if (admin.apps.length === 0) {
  try {
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || !process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET) {
      console.error('FATAL ERROR: NEXT_PUBLIC_FIREBASE_PROJECT_ID and NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET must be set in your .env file for Admin SDK initialization.');
      process.exit(1);
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: 'jobform-automator-website.appspot.com',
      databaseURL: 'https://jobform-automator-website-default-rtdb.firebaseio.com',
    });
    console.log('Firebase Admin SDK initialized successfully.');
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
    process.exit(1);
  }
}

const database = admin.database();
const bucket = admin.storage().bucket();
const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
if (!apiKey) {
  console.error('FATAL ERROR: NEXT_PUBLIC_GEMINI_API_KEY is not set in your .env file.');
}
const genAI = new GoogleGenerativeAI(apiKey || '');
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Adobe PDF Text Extraction
const extractTextFromPDF = async (inputFilePath, filename) => {
  let readStream;
  let outputZipPath = null; // Initialize to null
  const startTime = performance.now();
  try {
    if (!process.env.PDF_SERVICES_CLIENT_ID || !process.env.PDF_SERVICES_CLIENT_SECRET) {
      throw new Error("Missing or empty PDF_SERVICES_CLIENT_ID or PDF_SERVICES_CLIENT_SECRET in environment variables");
    }
    const credentials = new ServicePrincipalCredentials({
      clientId: process.env.PDF_SERVICES_CLIENT_ID,
      clientSecret: process.env.PDF_SERVICES_CLIENT_SECRET
    });
    const pdfServices = new PDFServices({ credentials });
    readStream = fs.createReadStream(inputFilePath);
    const inputAsset = await pdfServices.upload({
      readStream,
      mimeType: MimeType.PDF
    });
    const params = new ExtractPDFParams({
      elementsToExtract: [ExtractElementType.TEXT]
    });
    const job = new ExtractPDFJob({ inputAsset, params });
    const pollingURL = await pdfServices.submit({ job });
    const pdfServicesResponse = await pdfServices.getJobResult({
      pollingURL,
      resultType: ExtractPDFResult,
      timeout: 120000 // 120 seconds
    });
    const resultAsset = pdfServicesResponse.result.resource;
    const streamAsset = await pdfServices.getContent({ asset: resultAsset });
    outputZipPath = path.join(os.tmpdir(), `ExtractText_${Date.now()}_${filename}.zip`);
    await fsPromises.mkdir(path.dirname(outputZipPath), { recursive: true });
    const writeStream = fs.createWriteStream(outputZipPath);
    await new Promise((resolve, reject) => {
      streamAsset.readStream.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });
    const directory = await unzipper.Open.file(outputZipPath);
    const jsonFile = directory.files.find(file => file.path === 'structuredData.json');
    if (!jsonFile) throw new Error("structuredData.json not found in ZIP");
    const jsonContent = await jsonFile.buffer();
    const jsonData = JSON.parse(jsonContent.toString());
    let extractedText = "";
    if (jsonData.elements) {
      jsonData.elements.forEach(element => {
        if (element.Text) extractedText += element.Text + "\n";
      });
    }
    const duration = (performance.now() - startTime) / 1000;
    console.log(`Adobe extracted ${extractedText.length} chars from ${filename} in ${duration.toFixed(2)}s`);
    if (!extractedText || extractedText.length < 50) {
      throw new Error(`Insufficient text extracted: ${extractedText.length} chars`);
    }
    return extractedText.trim();
  } catch (err) {
    const duration = (performance.now() - startTime) / 1000;
    if (err instanceof SDKError || err instanceof ServiceUsageError || err instanceof ServiceApiError) {
      console.error(`Adobe SDK error for ${filename} after ${duration.toFixed(2)}s: ${err.message}`);
    } else {
      console.error(`Unexpected error for ${filename} after ${duration.toFixed(2)}s: ${err.message}`);
    }
    throw new Error(`Failed to extract text with Adobe SDK: ${err.message}`);
  } finally {
    if (readStream) {
      try {
        readStream.destroy();
      } catch (err) {
        console.error(`Error closing readStream for ${filename}: ${err.message}`);
      }
    }
    if (outputZipPath && fs.existsSync(outputZipPath)) {
      try {
        await fsPromises.unlink(outputZipPath);
        console.log(`Cleaned up Adobe ZIP file: ${outputZipPath}`);
      } catch (cleanupErr) {
        if (cleanupErr.code !== 'ENOENT') {
          console.error(`Error cleaning up Adobe ZIP file ${outputZipPath} for ${filename}: ${cleanupErr.message}`);
        }
      }
    }
  }
};

// pdf-parse Text Extraction
const extractTextFromPdf = async (filePath, filename) => {
  console.log(`Processing temp file: ${filePath} for ${filename} with pdf-parse`);
  try {
    const dataBuffer = await fsPromises.readFile(filePath);
    const data = await pdf(dataBuffer);
    const extractedText = data.text.trim();
    console.log(`Extracted text (${extractedText.length} chars) from ${filename} using pdf-parse`);
    if (!extractedText || extractedText.length < 50) {
      console.warn(`Insufficient text extracted from ${filename}: ${extractedText.length} characters.`);
      throw new Error(`Insufficient or invalid text content extracted from ${filename}`);
    }
    console.log("text",extractedText)
    return extractedText;
  } catch (error) {
    console.error(`pdf-parse error for ${filename}:`, error.message);
    if (error.message.includes('Invalid PDF structure') || error.message.includes('Corrupted')) {
      throw new Error(`Invalid or corrupted PDF file: ${filename}`);
    }
    throw new Error(`Failed to parse PDF with pdf-parse: ${error.message}`);
  }
};

// Combined Text Extraction with Fallback for Premium Users
const extractTextWithFallback = async (filePath, filename, isPremium) => {
  let pdfParseFailed = false;
  try {
    const text = await extractTextFromPdf(filePath, filename);
    return { text, pdfParseFailed };
  } catch (error) {
    console.warn(`pdf-parse failed for ${filename}: ${error.message}`);
    pdfParseFailed = true;
    if (isPremium) {
      console.log(`Falling back to Adobe PDF Services for premium user: ${filename}`);
      try {
        const adobeText = await extractTextFromPDF(filePath, filename);
        return { text: adobeText, pdfParseFailed };
      } catch (adobeError) {
        console.error(`Adobe parsing also failed for ${filename}: ${adobeError.message}`);
        throw new Error(`Both pdf-parse and Adobe failed: ${adobeError.message}`);
      }
    } else {
      console.log(`Not using Adobe fallback for free user: ${filename}`);
      throw error;
    }
  }
};

// Clean Gemini JSON Response
const cleanGeminiJson = (raw) => {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.substring(7, cleaned.indexOf('```', 7)).trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3, cleaned.indexOf('```', 3)).trim();
  }
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }
  return cleaned;
};

// Validate Candidate Data
const validateCandidate = (candidateData) => {
  candidateData = candidateData || {};
  const emailInput = candidateData.email && typeof candidateData.email === 'string' ? candidateData.email.trim().toLowerCase() : '';
  const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
  const fallbackEmailFromName =
    candidateData.name &&
    typeof candidateData.name === 'string' &&
    candidateData.name.trim() !== '' &&
    candidateData.name.trim().toLowerCase() !== 'n/a'
      ? `${candidateData.name.trim().replace(/\s+/g, '').toLowerCase()}@gmail.com`
      : `unknown_${uuidv4()}@gmail.com`;
  const email = emailInput && emailRegex.test(emailInput) ? emailInput : fallbackEmailFromName;
  return {
    id: candidateData.id || uuidv4(),
    name:
      candidateData.name && typeof candidateData.name === 'string' && candidateData.name.trim() !== '' && candidateData.name.trim().toLowerCase() !== 'n/a'
        ? candidateData.name.trim()
        : 'Unknown',
    email: email,
    phone:
      candidateData.phone && typeof candidateData.phone === 'string' && candidateData.phone.trim() !== '' && candidateData.phone.trim().toLowerCase() !== 'n/a'
        ? candidateData.phone.trim()
        : 'N/A',
    location:
      candidateData.location && typeof candidateData.location === 'string' && candidateData.location.trim() !== '' && candidateData.location.trim().toLowerCase() !== 'n/a'
        ? candidateData.location.trim()
        : 'N/A',
    score: typeof candidateData.score === 'number' ? Math.max(0, Math.min(100, Math.round(candidateData.score))) : 0,
    parsedText: candidateData.parsedText && typeof candidateData.parsedText === 'string' && candidateData.parsedText.trim() ? candidateData.parsedText.trim() : 'No summary provided.',
    skills: Array.isArray(candidateData.skills) ? candidateData.skills.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [],
    experience: typeof candidateData.experienceYears === 'number' && candidateData.experienceYears >= 0 ? Math.round(candidateData.experienceYears) : 0,
    jobTitle:
      candidateData.jobTitle && typeof candidateData.jobTitle === 'string' && candidateData.jobTitle.trim() !== '' && candidateData.jobTitle.trim().toLowerCase() !== 'n/a'
        ? candidateData.jobTitle.trim()
        : 'N/A',
    education:
      candidateData.education && typeof candidateData.education === 'string' && candidateData.education.trim() !== '' && candidateData.education.trim().toLowerCase() !== 'n/a'
        ? candidateData.education.trim()
        : 'N/A',
    approved: typeof candidateData.approved === 'boolean' ? candidateData.approved : false,
    resumeUrl: candidateData.resumeUrl || 'N/A',
  };
};

// Extract Email from Text
const extractEmailFromText = (text) => {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = text.match(emailRegex);
  return matches && matches.length > 0 ? matches[0].toLowerCase() : null;
};

// Parse Resume with Gemini
const parseWithGemini = async (text, jobDescription, recruiterSuggestion) => {
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
- Analyze Job Description: Identify core requirements, essential skills (technical & soft), required experience (years, type), specific tools/technologies, key responsibilities, and educational prerequisites mentioned in the JD.
- Analyze Recruiter Suggestions: Identify specific points of emphasis, desired candidate attributes, potential red flags to watch for, and any formatting or content preferences mentioned in the RS.
- Analyze Resume: Extract candidate's contact information, location, work experience (roles, duration, responsibilities, achievements), listed skills, and education.

JD Match Assessment (50% Weight):
- Assess the direct match between the candidate's skills/experience and the JD's essential requirements.
- Evaluate the relevance and depth of the candidate's experience concerning the JD's responsibilities.
- Check for the presence of keywords, tools, and technologies specified in the JD.
- Consider the alignment of education and years of experience with JD requirements.
- Assign a score out of 100 for JD fit.

RS Match Assessment (50% Weight):
- Assess how well the resume addresses the specific points, priorities, and concerns raised in the RS.
- Evaluate if the resume avoids any red flags mentioned by the recruiter.
- Check if the resume presentation or content aligns with the recruiter's preferences (if specified).
- Assign a score out of 100 for RS fit.

Calculate Final Score:
- Compute the final score as \`(JD Match Score * 0.5) + (RS Match Score * 0.5)\`. Round to the nearest whole number.

Synthesize Evaluation Summary:
- Write a concise summary (\`parsedText\`) explaining the score. Highlight key strengths (points of strong alignment with both JD and RS) and weaknesses (significant gaps or areas where the resume fails to meet JD requirements or RS expectations). Be specific.

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
  "experienceYears": /* Total years of relevant experience inferred, extracted from resume */,
  "jobTitle": "Most recent relevant job title (Extract from resume)",
  "education": "Harmonized highest relevant degree/qualification (Extract from resume)"
}
\`\`\`
`;

  try {
    if (!apiKey) {
      console.error('Gemini API key is not configured within parseWithGemini. Skipping Gemini call.');
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

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
    const result = await model.generateContent(prompt);
    if (!result || !result.response || typeof result.response.text !== 'function') {
      console.error('Gemini API returned an unexpected empty result or response format.');
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
      console.error('Gemini returned empty or whitespace-only content after cleaning.');
      console.error('Gemini Raw Output (before cleaning):', raw);
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

// Upload to Firebase Storage
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
      public: true,
    });

    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(filePath);
      readStream
        .pipe(uploadStream)
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

// Save Candidate to Realtime Database
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
      processedAt: admin.database.ServerValue.TIMESTAMP,
    };

    Object.keys(dataToSave).forEach((key) => (dataToSave[key] === undefined || dataToSave[key] === null ? delete dataToSave[key] : {}));
    await candidateRef.set(dataToSave);
    console.log(`✅ Candidate ${candidate.id} saved successfully to DB`);
  } catch (error) {
    console.error(`❌ Error saving candidate ${candidate.id} to Realtime Database:`, error);
  }
};

// Process Files in Batches
async function processInBatches(items, batchSize, processBatchFn) {
  const results = [];
  const totalBatches = Math.ceil(items.length / batchSize);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    console.log(`--- Starting batch ${Math.floor(i / batchSize) + 1}/${totalBatches} with ${batch.length} items ---`);
    const batchResults = await processBatchFn(batch);
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      console.log(`--- Batch processed. Waiting 5 seconds before next batch... ---`);
      await delay(5000);
    }
  }
  return results;
}

// Process Resume Files
const processResumeFiles = async (multerFiles, jobDescription, recruiterSuggestion, isPremium) => {
  console.log(`Starting resume processing for ${multerFiles.length} file(s) received. Premium: ${isPremium}`);
  const pdfParseFailedFiles = [];

  // Check for API key and Firebase initialization
  if (!apiKey || admin.apps.length === 0 || !database || !bucket) {
    const reason = !apiKey ? 'Gemini API Key is not configured.' : 'Firebase Admin SDK failed to initialize.';
    console.error(`Cannot process files: ${reason}`);
    return {
      success: false,
      totalProcessed: multerFiles.length,
      candidates: [],
      pdfParseFailedFiles,
      message: `Processing aborted: ${reason}`,
    };
  }

  // Handle no files case
  if (multerFiles.length === 0) {
    console.log('No files provided to process.');
    return {
      success: true,
      totalProcessed: 0,
      candidates: [],
      pdfParseFailedFiles,
      message: 'No files were provided for processing.',
    };
  }

  // Filter PDF and non-PDF files
  const pdfFiles = multerFiles.filter((file) => file.mimetype === 'application/pdf');
  const nonPdfFiles = multerFiles.filter((file) => file.mimetype !== 'application/pdf');
  if (nonPdfFiles.length > 0) {
    console.warn(`Skipping ${nonPdfFiles.length} non-PDF file entries.`);
    nonPdfFiles.forEach((file) => {
      pdfParseFailedFiles.push(file.originalname);
      admin.database().ref(`failed_pdf_parse/${uuidv4()}`).set({
        filename: file.originalname,
        reason: 'Non-PDF file type',
        timestamp: admin.database.ServerValue.TIMESTAMP,
      }).catch((error) => console.error(`Failed to save ${file.originalname} to failed_pdf_parse: ${error.message}`));
    });
  }

  // Handle no valid PDFs case
  if (pdfFiles.length === 0) {
    console.log('No valid PDF files found after filtering.');
    return {
      success: true,
      totalProcessed: multerFiles.length,
      validPdfProcessed: 0,
      invalidFilesSkipped: nonPdfFiles.length,
      candidates: [],
      pdfParseFailedFiles,
      message: 'No valid PDF files were provided for processing.',
    };
  }

  console.log(`Found ${pdfFiles.length} valid PDF files to process.`);
  const candidates = await processInBatches(pdfFiles, 5, async (batch) => {
    const batchResults = [];
    for (const file of batch) {
      if (!file || !file.path || !file.originalname) {
        console.warn(`Skipping invalid multer file entry in batch (unexpected).`);
        continue;
      }
      const { path: filePath, originalname: filename } = file;
      console.log(`-> Processing file: ${filename} (Temp Path: ${filePath}, Size: ${file.size} bytes)`);
      const id = uuidv4();
      try {
        const { text, pdfParseFailed } = await extractTextWithFallback(filePath, filename, isPremium);
        if (pdfParseFailed) {
          pdfParseFailedFiles.push(filename);
          await admin.database().ref(`failed_pdf_parse/${uuidv4()}`).set({
            filename,
            reason: 'pdf-parse failed',
            timestamp: admin.database.ServerValue.TIMESTAMP,
          }).catch((error) => console.error(`Failed to save ${filename} to failed_pdf_parse: ${error.message}`));
          console.log(`-> Logged ${filename} to pdfParseFailedFiles and Firebase.`);
          if (!isPremium) {
            console.log(`-> Skipping ${filename} for free user due to pdf-parse failure.`);
            continue; // Skip for free users without creating a candidate
          }
        }
        if (!text || text.trim().length < 50) {
          console.warn(`Skipping file ${filename}: insufficient or invalid text content (${text?.length || 0} characters) after extraction.`);
          pdfParseFailedFiles.push(filename);
          await admin.database().ref(`failed_pdf_parse/${uuidv4()}`).set({
            filename,
            reason: 'Insufficient text extracted',
            timestamp: admin.database.ServerValue.TIMESTAMP,
          }).catch((error) => console.error(`Failed to save ${filename} to failed_pdf_parse: ${error.message}`));
          console.log(`-> Logged ${filename} to pdfParseFailedFiles due to insufficient text.`);
          continue; // Skip without creating a candidate
        }
        console.log(`-> Sending text from ${filename} to Gemini...`);
        const parsedCandidateData = await parseWithGemini(text, jobDescription, recruiterSuggestion);
        const candidate = validateCandidate({
          ...parsedCandidateData,
          id: id,
          approved: false,
          resumeUrl: 'N/A',
        });
        console.log(`-> Gemini parsing attempted for ${filename}. Result name: ${candidate.name}, Score: ${candidate.score}`);
        const geminiErrorNames = ['API Key Missing', 'API No Response', 'Empty AI Response', 'JSON Parse Failed', 'Content Blocked', 'Parsing Failed'];
        if (geminiErrorNames.includes(candidate.name)) {
          console.warn(`-> Gemini returned a fatal error status for ${filename}: ${candidate.name}. Skipping.`);
          pdfParseFailedFiles.push(filename);
          await admin.database().ref(`failed_pdf_parse/${uuidv4()}`).set({
            filename,
            reason: `Gemini parsing error: ${candidate.name}`,
            timestamp: admin.database.ServerValue.TIMESTAMP,
          }).catch((error) => console.error(`Failed to save ${filename} to failed_pdf_parse: ${error.message}`));
          continue; // Skip without creating a candidate
        }
        try {
          const resumeUrl = await uploadToFirebaseStorage(filePath, filename, id);
          candidate.resumeUrl = resumeUrl;
          console.log(`-> Uploaded ${filename} to storage. URL: ${resumeUrl}`);
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
        pdfParseFailedFiles.push(filename);
        await admin.database().ref(`failed_pdf_parse/${uuidv4()}`).set({
          filename,
          reason: errorMessage.includes('pdf-parse') ? 'pdf-parse failed' : errorMessage,
          timestamp: admin.database.ServerValue.TIMESTAMP,
        }).catch((error) => console.error(`Failed to save ${filename} to failed_pdf_parse: ${error.message}`));
        console.log(`-> Logged ${filename} to pdfParseFailedFiles due to error: ${errorMessage}`);
        continue; // Skip without creating a candidate
      } finally {
        try {
          await fsPromises.access(filePath);
          await fsPromises.unlink(filePath);
          console.log(`Cleaned up temp file: ${filePath}`);
        } catch (cleanupErr) {
          if (cleanupErr.code !== 'ENOENT') {
            console.error(`Error cleaning up temp file ${filePath} for ${filename}:`, cleanupErr);
          }
        }
      }
    }
    return batchResults;
  });

  const sortedCandidates = candidates.sort((a, b) => b.score - a.score);
  console.log(`\n--- Finished processing ${candidates.length} valid PDF file(s). ---\n`);
  return {
    success: true,
    totalProcessed: multerFiles.length,
    validPdfProcessed: candidates.length,
    invalidFilesSkipped: nonPdfFiles.length,
    candidates: sortedCandidates,
    pdfParseFailedFiles,
    message: 'Processing complete.',
  };
};

// Express App Setup
const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = [
  'https://www.jobformautomator.com',
  'https://jobformautomator.com',
  'http://localhost:3000', // For local development
  'http://localhost:5173', // Common for Vite/React dev servers
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g., non-browser clients like Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Configure Multer for Single File Upload
const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, callback) => {
    if (file.mimetype === 'application/pdf') {
      callback(null, true);
    } else {
      callback(new Error(`Invalid file type: ${file.originalname}. Only PDF files are allowed.`), false);
    }
  },
});

// Multer Error Handling Middleware
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
  const isPremium = req.body.status === 'true' || req.body.status === true;
  console.log(`User isPremium: ${isPremium}`);

  try {
    if (!tempFile) {
      console.log('No file received in the request.');
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload a PDF file with the field name \'file\'.',
        pdfParseFailedFiles: [],
      });
    }

    console.log(`Received file: ${tempFile.originalname}`);
    console.log('JD (partial):', jobDescription.substring(0, Math.min(jobDescription.length, 100)) + (jobDescription.length > 100 ? '...' : ''));
    console.log('RS (partial):', recruiterSuggestion.substring(0, Math.min(recruiterSuggestion.length, 100)) + (recruiterSuggestion.length > 100 ? '...' : ''));

    if (!apiKey || admin.apps.length === 0 || !database || !bucket) {
      const reason = !apiKey ? 'Gemini API Key is not configured.' : 'Firebase Admin SDK failed to initialize.';
      console.error(`Cannot process file: ${reason}`);
      const id = uuidv4();
      const candidate = validateCandidate({
        id: id,
        name: reason.includes('Gemini') ? 'API Key Missing' : 'Service Error',
        email: `${reason.includes('Gemini') ? 'api_key_missing' : 'service_error'}_${id}@example.com`,
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
        pdfParseFailedFiles: [],
        error: reason,
      });
    }

    const results = await processResumeFiles([tempFile], jobDescription, recruiterSuggestion, isPremium);
    const candidate = results.candidates[0] || null;

    if (!candidate) {
      return res.status(500).json({
        success: false,
        error: 'Failed to process file: No candidate data returned.',
        pdfParseFailedFiles: results.pdfParseFailedFiles,
      });
    }

    res.status(200).json({
      success: true,
      candidate,
      pdfParseFailedFiles: results.pdfParseFailedFiles,
    });
  } catch (error) {
    const errorMessage = error.message || 'Unexpected error during processing.';
    console.error('[Overall Request Error]', errorMessage, error);
    if (tempFile && tempFile.path) {
      try {
        await fsPromises.access(tempFile.path);
        await fsPromises.unlink(tempFile.path);
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
      pdfParseFailedFiles: [],
    });
  }
});

app.post('/', (req, res) => {
  return res.send({ message: 'hello from parse resume' });
});

// Start the Express Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Resume parsing endpoint: POST http://localhost:${PORT}/parse-resumes`);
});