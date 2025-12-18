// api/clean_expired_offers.js (MODIFICATO)

// Importa le librerie necessarie
const admin = require('firebase-admin');
const fetch = require('node-fetch'); 
const path = require('path'); 

// Variabile globale per il database di Firestore
let db;

// Inizializza Firebase Admin SDK
if (!admin.apps.length) {
  let firebaseConfig = null;
  const firebaseServiceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (firebaseServiceAccountKey) {
    try {
      firebaseConfig = JSON.parse(firebaseServiceAccountKey);
    } catch (e) {
      try {
        firebaseConfig = JSON.parse(Buffer.from(firebaseServiceAccountKey, 'base64').toString('utf8'));
      } catch (e2) {
        console.error("FIREBASE_SERVICE_ACCOUNT_KEY: Errore nel parsing:", e2.message);
      }
    }
  }

  if (firebaseConfig) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig)
      });
      db = admin.firestore();
      console.log("Firebase Admin SDK inizializzato per clean_expired_offers.");
    } catch (initError) {
      console.error("Errore nell'inizializzazione di Firebase Admin SDK:", initError.message);
    }
  } else {
    console.error("FIREBASE_SERVICE_ACCOUNT_KEY non trovata. Firebase Admin SDK non inizializzato.");
  }
} else {
  db = admin.firestore();
}

// Funzione helper per determinare se il dispositivo è mobile (basato sul user-agent)
function isMobile(userAgent) {
    return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|Opera Mini|Windows Phone/i.test(userAgent);
}

// Funzione helper per generare colori light/dark/gradient dal colore base
function generateVendorColors(baseColor) {
    const defaultCivoraColors = {
        primary: '#FF6600',
        light: '#FF8533',
        dark: '#E65C00',
        gradient: 'linear-gradient(135deg, #FF8533 0%, #E65C00 100%)'
    };

    if (!baseColor || baseColor.toLowerCase() === 'default') {
        return defaultCivoraColors;
    }

    // Funzioni helper per manipolare colori esadecimali
    const hexToRgb = hex => {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return { r: 0, g: 0, b: 0 };
        let r = 0, g = 0, b = 0;
        if (hex.length === 4) {
            r = parseInt(hex[1] + hex[1], 16);
            g = parseInt(hex[2] + hex[2], 16);
            b = parseInt(hex[3] + hex[3], 16);
        } else if (hex.length === 7) {
            r = parseInt(hex.substring(1, 3), 16);
            g = parseInt(hex.substring(3, 5), 16);
            b = parseInt(hex.substring(5, 7), 16);
        }
        return { r, g, b };
    };

    const rgbToHex = (r, g, b) => {
        r = Math.max(0, Math.min(255, r));
        g = Math.max(0, Math.min(255, b));
        b = Math.max(0, Math.min(255, b));
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).padStart(6, '0').toUpperCase();
    };

    const adjustColorBrightness = (hex, percent) => {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) {
            return hex;
        }
        let { r, g, b } = hexToRgb(hex);

        r = Math.round(r * (100 + percent) / 100);
        g = Math.round(g * (100 + percent) / 100);
        b = Math.round(b * (100 + percent) / 100);

        return rgbToHex(r, g, b);
    };

    try {
        const lightColor = adjustColorBrightness(baseColor, 20); 
        const darkColor = adjustColorBrightness(baseColor, -20); 

        return {
            primary: baseColor,
            light: lightColor,
            dark: darkColor,
            gradient: `linear-gradient(135deg, ${lightColor} 0%, ${darkColor} 100%)`
        };
    } catch (e) {
        console.warn("Errore nella derivazione colori, usando default:", e);
        return defaultCivoraColors; // Fallback in caso di errore nella derivazione
    }
}


// Funzione principale che verrà eseguita da Vercel
module.exports = async (req, res) => {
    // === IMPOSTAZIONI CORS AVANZATE ===
    const allowedOrigins = [
        process.env.FRONTEND_BASE_URL,
        process.env.DASHBOARD_BASE_URL
    ].filter(Boolean); // Filtra eventuali valori null/undefined

    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (process.env.NODE_ENV !== 'production') {
        console.warn(`[Vercel Function] Richiesta da origine non consentita in produzione: ${origin}`);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Gestione preflight CORS (richieste OPTIONS)
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // === LEGGI IL PARAMETRO 'action' DALLA QUERY STRING ===
    const action = req.query.action; 
    const slug = req.query.slug;     

    console.log(`[Vercel Function] Richiesta ricevuta. Action: "${action}", Origin: "${origin || 'N/A'}", Slug: "${slug || 'N/A'}"`);

    switch (action) {
        case 'renderStorePage':
            if (!slug) {
                console.error("Errore: slug non specificato per l'azione renderStorePage.");
                return res.status(404).send('<h1>404 Not Found</h1><p>Negozio non specificato nell\'URL.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
            }

            try {
                const vendorsRef = db.collection('vendors');
                const querySnapshot = await vendorsRef.where('slug', '==', slug).limit(1).get();

                if (querySnapshot.empty) {
                    console.warn(`Venditore con slug "${slug}" non trovato.`);
                    return res.status(404).send('<h1>404 Not Found</h1><p>Il negozio che cerchi non esiste su Civora.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
                }

                const vendorDoc = querySnapshot.docs[0];
                const vendorData = vendorDoc.data();
                const vendorId = vendorDoc.id; 
                const shopColor = vendorData.shopColor || '#FF6600'; 
                const userType = vendorData.userType || 'negoziante'; 

                const userAgent = req.headers['user-agent'] || '';
                const isMobileDevice = isMobile(userAgent);

                let pageNameBase = 'vendor_store_detail'; 
                switch (userType) {
                    case 'alimentari':
                        pageNameBase = 'alimentari_detail';
                        break;
                    case 'mercato_fresco':
                        pageNameBase = 'mercato_fresco_detail';
                        break;
                    case 'noleggio': 
                        pageNameBase = 'sezione_noleggio_facile/noleggio_desktop'; 
                        break;
                    case 'used_negoziante': 
                        pageNameBase = 'used_vendor_store_detail';
                        break;
                    default:
                        pageNameBase = 'vendor_store_detail'; 
                        break;
                }

                let htmlFileName;
                if (isMobileDevice) {
                    if (pageNameBase === 'sezione_noleggio_facile/noleggio_desktop') {
                        htmlFileName = 'sezione_noleggio_facile/noleggio_mobile.html';
                    } else {
                        htmlFileName = `${pageNameBase}_mobile.html`;
                    }
                } else {
                    if (['alimentari_detail', 'mercato_fresco_detail'].includes(pageNameBase)) {
                        htmlFileName = `${pageNameBase}.html`; 
                    } else if (pageNameBase === 'sezione_noleggio_facile/noleggio_desktop') {
                        htmlFileName = 'sezione_noleggio_facile/noleggio_desktop.html'; 
                    } else {
                        htmlFileName = `${pageNameBase}_desktop.html`; 
                    }
                }
                
                console.log(`[Vercel Function] Tentativo di scaricare HTML per userType "${userType}" (Dispositivo mobile: ${isMobileDevice}): ${htmlFileName}`);

                const frontendBaseUrl = process.env.FRONTEND_BASE_URL; 
                if (!frontendBaseUrl) {
                    console.error("FRONTEND_BASE_URL non impostata nelle variabili d'ambiente di Vercel!");
                    return res.status(500).send('<h1>500 Internal Server Error</h1><p>Configurazione del server non completata. Contatta l\'amministrazione.</p>', { headers: { 'Content-Type': 'text/html' } });
                }
                const htmlFullUrl = `${frontendBaseUrl}/${htmlFileName}`;
                console.log(`[Vercel Function] Scarico HTML da: ${htmlFullUrl}`);
                
                const htmlResponse = await fetch(htmlFullUrl);
                if (!htmlResponse.ok) {
                    console.error(`[Vercel Function] Errore nel download del file HTML (${htmlResponse.status}): ${htmlFullUrl}`);
                    if (htmlResponse.status === 404) {
                        return res.status(404).send(`<h1>404 Not Found</h1><p>La pagina specifica per questo negozio non è stata trovata. (${htmlFileName})</p><p>Torna alla <a href="${frontendBaseUrl}">Homepage Civora</a></p>`, { headers: { 'Content-Type': 'text/html' } });
                    }
                    throw new Error(`Impossibile scaricare il file HTML: ${htmlResponse.statusText}`);
                }
                let htmlContent = await htmlResponse.text();

                const vendorColors = generateVendorColors(shopColor);
                const dynamicStyle = `
                    <style id="vendor-dynamic-styles">
                        :root {
                            --vendor-primary-color: ${vendorColors.primary};
                            --vendor-primary-light: ${vendorColors.light};
                            --vendor-primary-dark: ${vendorColors.dark};
                            --vendor-primary-gradient: ${vendorColors.gradient};
                            --price-color: ${vendorColors.primary}; 
                        }
                    </style>
                `;

                htmlContent = htmlContent.replace('<!-- VENDOR_STYLE_INJECTION -->', dynamicStyle);
                htmlContent = htmlContent.replace('<body', `<body data-vendor-id="${vendorId}" data-vendor-color="${shopColor}"`);

                return res.status(200).send(htmlContent, { headers: { 'Content-Type': 'text/html' } });

            } catch (error) {
                console.error("[Vercel Function] Errore critico nel rendere la pagina del negozio:", error);
                return res.status(500).send('<h1>500 Internal Server Error</h1><p>Si è verificato un problema tecnico inaspettato nel caricamento del negozio.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
            }

        case 'proxyBarcodeLookup':
            console.log("[Vercel Function] Esecuzione azione: proxyBarcodeLookup");
            const barcode = req.query.barcode;
            const apiType = req.query.apiType; 

            if (!barcode || !apiType) {
                console.warn("[Vercel Function] Parametri mancanti per proxyBarcodeLookup.");
                return res.status(400).json({ error: 'Codice a barre o tipo API mancante.' });
            }

            let apiUrl;
            const fetchOptions = {}; 

            switch (apiType) {
                case 'upcitemdb':
                    // RIMOSSA LA LOGICA CHIAVE API PER UPCITEMDB - USARE ACCESSO FREE
                    apiUrl = `https://api.upcitemdb.com/prod/v1/lookup?upc=${barcode}`;
                    console.log(`[Vercel Function] Proxying UPCitemdb (Free access): ${apiUrl}`);
                    break;
                case 'upcdatabase':
                    const upcdatabaseApiKey = process.env.UPCDATABASE_API_KEY;
                    if (!upcdatabaseApiKey) {
                        console.error("[Vercel Function] UPCDATABASE_API_KEY non impostata come variabile d'ambiente.");
                        return res.status(500).json({ error: 'Configurazione API chiave upcdatabase.org mancante sul server.' });
                    }
                    apiUrl = `https://api.upcdatabase.org/product/${barcode}?apikey=${upcdatabaseApiKey}`;
                    console.log(`[Vercel Function] Proxying UPCdatabase.org: ${apiUrl}`);
                    break;
                default:
                    console.warn(`[Vercel Function] Tipo API non supportato per proxy: ${apiType}`);
                    return res.status(400).json({ error: `Tipo API non supportato: ${apiType}` });
            }

            try {
                const apiResponse = await fetch(apiUrl, fetchOptions); 
                const data = await apiResponse.json();
                
                return res.status(apiResponse.status).json(data);

            } catch (proxyError) {
                console.error(`[Vercel Function] Errore durante il proxy per ${apiType}:`, proxyError);
                return res.status(500).json({ error: `Errore durante la ricerca proxy su ${apiType}.` });
            }

        case undefined: 
        case null:
        case 'cleanExpiredOffers': 
            const cronSecret = process.env.CRON_SECRET;
            const authHeader = req.headers['authorization'];

            if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
                console.warn('[Vercel Function] Tentativo di accesso non autorizzato alla funzione Cron.');
                return res.status(401).json({ error: 'Accesso non autorizzato.' });
            }

            console.log("🚀 Inizio pulizia offerte scadute...");

            if (!db) {
                console.error("DB non inizializzato. Impossibile procedere.");
                return res.status(500).json({ error: "Errore interno del server: DB non pronto." });
            }

            const now = admin.firestore.Timestamp.now();
            let movedOffersCount = 0;
            const batch = db.batch();

            try {
                const expiredByDateQuery = db.collection('alimentari_offers').where('endDate', '<', now);
                const expiredByDateSnapshot = await expiredByDateQuery.get();

                expiredByDateSnapshot.forEach(doc => {
                    console.log(`⏳ Trovata offerta scaduta per data: ${doc.id}`);
                    const offerData = doc.data();
                    const expiredOfferRef = db.collection('expired_offers_trash').doc(doc.id);
                    
                    batch.set(expiredOfferRef, { ...offerData, expiredAt: now, reason: 'Date Expired' });
                    batch.delete(doc.ref);
                    movedOffersCount++;
                });

                const expiredByQuantityQuery = db.collection('alimentari_offers').where('quantity', '<=', 0);
                const expiredByQuantitySnapshot = await expiredByQuantityQuery.get();
                
                expiredByQuantitySnapshot.forEach(doc => {
                    if (!expiredByDateSnapshot.docs.some(d => d.id === doc.id)) {
                        console.log(`🗑️ Trovata offerta con quantità esaurita: ${doc.id}`);
                        const offerData = doc.data();
                        const expiredOfferRef = db.collection('expired_offers_trash').doc(doc.id);
                        
                        batch.set(expiredOfferRef, { ...offerData, expiredAt: now, reason: 'Quantity Depleted' });
                        batch.delete(doc.ref);
                        movedOffersCount++;
                    }
                });

                if (movedOffersCount > 0) {
                    await batch.commit();
                    console.log(`✅ Successo! Spostate ${movedOffersCount} offerte nel cestino.`);
                } else {
                    console.log("👍 Nessuna offerta scaduta da pulire oggi.");
                }

                return res.status(200).json({ success: true, message: `Spostate ${movedOffersCount} offerte nel cestino.` });

            } catch (error) {
                console.error("❌ Errore durante la pulizia delle offerte:", error);
                return res.status(500).json({ success: false, error: error.message });
            }

        default:
            console.warn(`[Vercel Function] Azione non riconosciuta: "${action}"`);
            return res.status(400).send('<h1>400 Bad Request</h1><p>Azione Vercel Function non valida.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
    }
};
