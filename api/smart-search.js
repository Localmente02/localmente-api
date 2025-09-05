const admin = require('firebase-admin');
const OpenAI = require('openai');
const translate = require('@iamtraction/google-translate');
const { Resend } = require('resend'); // <<< NUOVO INNESTO: IL NOSTRO POSTINO

// 🔹 Inizializzazione Firebase Admin
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    });
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error', e.stack);
}
const db = admin.firestore();

// 🔹 Configurazione OpenRouter AI
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// 🔹 Configurazione Resend (il postino)
const resend = new Resend(process.env.RESEND_API_KEY); // <<< NUOVO: Prende la chiave che ti farò ottenere

// ====================================================================
// ==================== NUOVA FUNZIONE PER LE EMAIL ===================
// ====================================================================
async function handleSendVerificationEmail(req, res) {
  const { userEmail, userName, verificationCode } = req.body;

  if (!userEmail || !userName || !verificationCode) {
    return res.status(400).json({ error: 'Dati mancanti per inviare l\'email di verifica.' });
  }

  try {
    const { data, error } = await resend.emails.send({
      from: 'Localmente <noreply@localmente.app>', // IMPORTANTE: Dovrai configurare questo dominio su Resend
      to: [userEmail],
      subject: `Il tuo codice di verifica per Localmente è ${verificationCode}`,
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <img src="URL_DEL_TUO_LOGO" alt="Localmente Logo" style="width: 150px; margin-bottom: 20px;">
          <h2>Ciao ${userName},</h2>
          <p>Grazie per esserti registrato a Localmente! Per completare la registrazione, usa il seguente codice:</p>
          <p style="font-size: 24px; font-weight: bold; letter-spacing: 5px; background-color: #f0f0f0; padding: 10px; border-radius: 5px;">
            ${verificationCode}
          </p>
          <p>Se non hai richiesto tu questo codice, puoi ignorare questa email.</p>
          <p>A presto,<br>Il Team di Localmente</p>
        </div>
      `,
    });

    if (error) {
      console.error('[Vercel] Errore invio email con Resend:', error);
      return res.status(500).json({ error: 'Errore durante l\'invio dell\'email.', details: error.message });
    }

    console.log('[Vercel] Email di verifica inviata con successo a:', userEmail);
    return res.status(200).json({ success: true, message: 'Email inviata.' });

  } catch (error) {
    console.error('[Vercel] Errore generico in handleSendVerificationEmail:', error);
    return res.status(500).json({ error: 'Errore interno del server.', details: error.message });
  }
}

// ====================================================================
// ================== VECCHIA FUNZIONE DI RICERCA =====================
// ====================================================================
const fetchAllFromCollection = async (collectionName, type) => {
  // ... (questa funzione rimane identica, non la modifico)
  try {
    const snapshot = await db.collection(collectionName)
                               .where('isAvailable', '==', true)
                               .get();
    if (snapshot.empty) return [];

    return snapshot.docs.map(doc => {
      const data = doc.data();
      const docType = data.type || type;
      let adaptedData = { ...data };

      if (docType === 'kit') {
        adaptedData.productName = data.kitName;
        adaptedData.price = data.basePrice;
        adaptedData.productImageUrl = data.imageUrl;
        adaptedData.brand = data.vendorStoreName;
        adaptedData.kitName = data.kitName;
        adaptedData.recipeText = data.recipeText;
        adaptedData.videoUrl = data.videoUrl;
        adaptedData.description = data.description;
        adaptedData.difficulty = data.difficulty;
        adaptedData.preparationTime = data.preparationTime;
        adaptedData.galleryImageUrls = data.galleryImageUrls;
        adaptedData.ingredients = data.kitDetails?.ingredientsList ?? data.ingredients;
        adaptedData.servingsData = data.kitDetails?.servingsData ?? data.servingsData;
      }
      return { id: doc.id, type: docType, data: adaptedData };
    });
  } catch (error) {
    console.error(`[Vercel] Errore fetch collezione '${collectionName}':`, error);
    return [];
  }
};

async function handleSmartSearch(req, res) {
  // ... (questa funzione rimane identica, non la modifico)
  try {
    let { userQuery } = req.body;
    if (!userQuery) userQuery = "all";
    
    let translatedQuery = userQuery;
    let aiResponseContent = null;
    let relevantData = [];

    if (userQuery !== "all") {
        try {
            const result = await translate(userQuery, { to: 'it' });
            translatedQuery = result.text;
        } catch (err) {
            console.error('[Vercel] Errore traduzione:', err);
        }

        const [globalCatalogItems, vendors] = await Promise.all([
          fetchAllFromCollection('global_product_catalog', 'product'),
          fetchAllFromCollection('vendors', 'vendor'),
        ]);
        relevantData = [...globalCatalogItems, ...vendors];

        const systemPrompt = `Sei un assistente di ricerca molto amichevole per una piattaforma e-commerce locale chiamata "Localmente". Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività nel database che ti passo. Rispondi SEMPRE in italiano, con tono positivo e utile, come un commesso esperto che consiglia. Non inventare nulla: usa solo i dati che ti vengono forniti.`;
        const userMessage = `Ecco la query dell'utente: "${translatedQuery}". Ecco i dati disponibili (JSON): ${JSON.stringify(relevantData)}. Genera una risposta naturale e utile, usando solo questi dati.`;

        const completion = await openai.chat.completions.create({
            model: "mistralai/mistral-7b-instruct",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
            temperature: 0.7,
            max_tokens: 300,
        });
        aiResponseContent = completion.choices[0].message.content;
    } else {
        const [globalCatalogItems, vendors] = await Promise.all([
            fetchAllFromCollection('global_product_catalog', 'product'),
            fetchAllFromCollection('vendors', 'vendor'),
        ]);
        relevantData = [...globalCatalogItems, ...vendors];
    }

    return res.status(200).json({
      query: translatedQuery,
      aiResponse: aiResponseContent,
      results: relevantData,
    });
  } catch (error) {
    console.error('[Vercel] ERRORE GENERALE in handleSmartSearch:', error);
    return res.status(500).json({ error: 'Errore interno', details: error.message });
  }
}


// ====================================================================
// ==================== IL NUOVO "DIRETTORE D'ORCHESTRA" ================
// ====================================================================
module.exports = async (req, res) => {
  // Gestione CORS (non modificata)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo non consentito' });

  // IL NUOVO INTERRUTTORE
  const { action } = req.body;

  switch (action) {
    case 'sendVerificationEmail':
      console.log("[Vercel] Richiesta azione: Invio Email di Verifica");
      return handleSendVerificationEmail(req, res);
    
    case 'search':
    default: // Se 'action' non è specificata, esegue la ricerca come prima
      console.log("[Vercel] Richiesta azione: Ricerca Intelligente (o default)");
      return handleSmartSearch(req, res);
  }
};
