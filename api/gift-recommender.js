// Questa è una Vercel Serverless Function.
// Riceve le preferenze utente, recupera prodotti da Firestore,
// interroga l'AI di Google Gemini e restituisce suggerimenti regalo.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Inizializza Firebase Admin SDK solo una volta per evitare errori di re-inizializzazione.
// `global.firebaseAdminApp` è un pattern comune per le funzioni serverless su Vercel.
let db;
if (!global.firebaseAdminApp) {
  try {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Importante per gestire i newline
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };
    global.firebaseAdminApp = initializeApp({
      credential: cert(serviceAccount),
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error);
    // In un ambiente di produzione, qui potresti voler lanciare un errore fatale
    // o un sistema di notifica, ma per ora il console.error è sufficiente.
  }
}
db = getFirestore(global.firebaseAdminApp);


export default async function (req, res) {
  // Configurazione CORS (Cross-Origin Resource Sharing)
  // Essenziale per permettere alla tua app Flutter (che gira su un dominio diverso) di chiamare questa API.
  res.setHeader('Access-Control-Allow-Origin', '*'); // Permette richieste da qualsiasi origine (per sviluppo)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); // Metodi HTTP permessi
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // Header permessi

  // Gestisce le richieste OPTIONS (chiamate "pre-flight") che i browser inviano prima delle richieste POST/GET reali.
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Assicurati che la richiesta sia di tipo POST.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non permesso. Si accettano solo richieste POST.' });
  }

  try {
    // Estrai le preferenze dell'utente e la posizione dalla richiesta (inviate dalla tua app Flutter).
    const { userPreferences, userCurrentLocation } = req.body;

    // Validazione base degli input
    if (!userPreferences || !userCurrentLocation || !userCurrentLocation.cap) {
      return res.status(400).json({ error: 'Mancano dati essenziali: userPreferences o CAP della posizione attuale.' });
    }

    const {
      interessi,
      eta,
      genere,
      budget,
      personalita,
      relazione,
      occasione,
      note_aggiuntive
    } = userPreferences;

    const userCap = userCurrentLocation.cap; // Il CAP dell'utente per filtrare i prodotti locali.

    // 1. Recupera i prodotti dal 'global_product_catalog' di Firebase.
    // L'obiettivo è filtrare per prodotti attivi, disponibili, nel CAP dell'utente,
    // e solo dai venditori "Piazza" (curati) per ottenere i migliori suggerimenti.
    let productsSnapshot;
    try {
        productsSnapshot = await db.collection('global_product_catalog')
            .where('isAvailable', '==', true) // Il prodotto deve essere disponibile in stock.
            .where('isMarketplaceActive', '==', true) // Il prodotto deve essere attivo sul marketplace.
            .where('vendorCap', '==', userCap) // Filtra i prodotti nel CAP specificato dall'utente.
            .where('isPiazzaVendor', '==', true) // Filtra solo i prodotti dei venditori "Piazza".
            .limit(500) // Limita il numero di prodotti per non sovraccaricare l'AI e la funzione.
            .get();
    } catch (firebaseError) {
        console.error("Errore nel recupero dei prodotti da Firestore:", firebaseError);
        return res.status(500).json({ error: "Errore interno durante il recupero dei prodotti disponibili." });
    }

    // Trasforma i documenti di Firebase in un formato più leggero per l'AI.
    const availableProducts = productsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: data.id,
        nome: data.productName,
        descrizione: data.description || '',
        categoria_principale: data.productCategory, // Mappato dal tuo 'categoryGroup'.
        sottocategoria: data.subCategory || '',
        prezzo: data.price,
        unita: data.unit || 'pezzo',
        isAvailable: data.isAvailable,
        imageUrl: data.productImageUrl || null,
        keywords: data.keywords || [], // Parole chiave per aiutare l'AI.
      };
    }).filter(p => p.isAvailable && p.prezzo > 0 && p.nome); // Filtro per assicurare dati validi.

    // Se non ci sono prodotti disponibili dopo i filtri, restituisci un messaggio.
    if (availableProducts.length === 0) {
        return res.status(404).json({ message: 'Nessun prodotto disponibile o corrispondente ai tuoi filtri nel tuo CAP. Prova a modificare le preferenze.' });
    }

    // 2. Costruisci il prompt per l'Intelligenza Artificiale (Google Gemini).
    const API_KEY = process.env.GOOGLE_API_KEY; // La tua chiave API di Google Gemini.
    if (!API_KEY) {
      console.error("GOOGLE_API_KEY non è configurata nelle variabili d'ambiente di Vercel.");
      return res.status(500).json({ error: 'Chiave API di Google Gemini mancante. Contatta l\'amministratore.' });
    }

    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" }); // Usiamo il modello "pro" per suggerimenti di qualità.

    // Il testo del prompt è la parte più importante: guida l'AI a generare la risposta desiderata.
    const promptText = `Sei un esperto selezionatore di regali unico e personalizzato sulla piattaforma Localmente. Il tuo obiettivo è suggerire i 3 migliori regali basandoti sui 'Dati Utente' e sui 'Prodotti Disponibili' che ti verranno forniti.

Dati Utente:
- Interessi: ${interessi ? interessi.join(', ') : 'non specificato'}
- Età: ${eta || 'non specificata'}
- Genere: ${genere || 'non specificato'}
- Budget: ${budget || 'non specificato'}
- Personalità: ${personalita || 'non specificata'}
- Relazione: ${relazione || 'non specificata'}
- Occasione: ${occasione || 'non specificata'}
- Note Aggiuntive: ${note_aggiuntive || 'nessuna'}

Prodotti Disponibili (formato JSON):
${JSON.stringify(availableProducts, null, 2)}

Istruzioni per i suggerimenti (Output JSON):
1.  Per ogni regalo suggerito, forniscimi ESATTAMENTE un oggetto JSON con i seguenti campi: "id", "nome", "prezzo", "spiegazione".
2.  L' "id" deve essere l'ID esatto del prodotto presente nella lista "Prodotti Disponibili".
3.  La "spiegazione" deve essere concisa (massimo 3 frasi) e collegare direttamente il regalo agli interessi, alla personalità o all'occasione del destinatario.
4.  I prodotti suggeriti DEVONO essere contrassegnati come 'isAvailable: true' nella lista dei "Prodotti Disponibili".
5.  I prodotti suggeriti DEVONO rientrare nel budget indicato dall'utente. Se il budget è una fascia (es. "50-100"), il prezzo del regalo deve essere all'interno di quella fascia. Se il budget è un valore singolo (es. "75"), il prezzo deve essere inferiore o uguale a quel valore. Se il budget non è specificato, puoi suggerire liberamente qualsiasi prezzo.
6.  Sii creativo e originale nei suggerimenti, pensando a come i prodotti locali possano essere perfetti.
7.  Presenta i risultati ESCLUSIVAMENTE come un array JSON di 3 oggetti. NON includere testo aggiuntivo, introduzioni, o formattazioni Markdown prima o dopo l'array JSON.

Esempio del formato di output DESIDERATO (SOLO L'ARRAY JSON):
[
  {
    "id": "prod_XYZ1",
    "nome": "Nome Prodotto Esempio 1",
    "prezzo": 55.00,
    "spiegazione": "Questo regalo è ideale perché..."
  },
  {
    "id": "prod_XYZ2",
    "nome": "Nome Prodotto Esempio 2",
    "prezzo": 80.00,
    "spiegazione": "Perfetto per la sua passione per..."
  },
  {
    "id": "prod_XYZ3",
    "nome": "Nome Prodotto Esempio 3",
    "prezzo": 42.50,
    "spiegazione": "Un'esperienza unica per l'occasione di..."
  }
]
`;

    // Chiamata all'API di Google Gemini per generare i suggerimenti.
    const result = await model.generateContent(promptText);
    const response = await result.response;
    let aiResponseText = response.text();

    // Pulizia dell'output dell'AI: a volte l'AI aggiunge '```json' o altri caratteri non necessari.
    const jsonMatch = aiResponseText.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch && jsonMatch[1]) {
        aiResponseText = jsonMatch[1]; // Estrai solo il contenuto JSON.
    } else {
        aiResponseText = aiResponseText.trim(); // Rimuovi spazi extra.
    }

    let parsedSuggestions;
    try {
        parsedSuggestions = JSON.parse(aiResponseText); // Tenta di parsare la stringa JSON.
        // Validazione aggiuntiva per assicurarsi che l'output sia un array di oggetti validi.
        if (!Array.isArray(parsedSuggestions) || parsedSuggestions.length === 0 || !parsedSuggestions[0] || !parsedSuggestions[0].id) {
            throw new Error("Formato JSON restituito dall'AI non valido o incompleto.");
        }
    } catch (parseError) {
        console.error("Errore nel parsing della risposta JSON dell'AI:", aiResponseText, parseError);
        return res.status(500).json({
            error: 'L\'Intelligenza Artificiale ha restituito un formato non valido. Si prega di riprovare più tardi.',
            rawAiOutput: aiResponseText // Includi l'output grezzo dell'AI per debug.
        });
    }

    // 3. Completa i suggerimenti con informazioni aggiuntive (es. URL immagine).
    // Questo è necessario perché l'AI riceve un set di dati ridotto per focalizzarsi sui suggerimenti,
    // ma la tua app ha bisogno dell'URL dell'immagine per mostrare il prodotto.
    const finalSuggestions = parsedSuggestions.map(suggestion => {
        const fullProduct = availableProducts.find(p => p.id === suggestion.id);
        if (fullProduct) {
            return {
                id: suggestion.id,
                nome: suggestion.nome,
                prezzo: suggestion.prezzo,
                spiegazione: suggestion.spiegazione,
                imageUrl: fullProduct.imageUrl, // Aggiunge l'URL dell'immagine dal prodotto originale.
                unit: fullProduct.unit, // Aggiunge l'unità di misura.
            };
        }
        return suggestion; // Restituisce il suggerimento anche se per qualche motivo il prodotto non viene trovato.
    }).filter(Boolean); // Rimuovi eventuali suggerimenti 'null' se un prodotto non è stato trovato.

    // Restituisci i suggerimenti all'app Flutter.
    res.status(200).json({ suggestions: finalSuggestions });

  } catch (error) {
    console.error('Errore generico durante la generazione dei suggerimenti:', error);
    // Errore generico del server.
    res.status(500).json({ error: 'Si è verificato un errore interno del server durante la generazione dei suggerimenti.' });
  }
}
