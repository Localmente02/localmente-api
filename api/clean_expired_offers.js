// api/clean_expired_offers.js

// Importa le librerie necessarie
const admin = require('firebase-admin');
const fetch = require('node-fetch'); // Necessario per scaricare i file HTML dal tuo frontend
const path = require('path'); // Per gestire i percorsi dei file HTML

// Variabile globale per il database di Firestore
let db;

// Inizializza Firebase Admin SDK (esattamente come nel webhook.js)
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

    // Funzioni helper per manipolare colori esadecimali (le stesse che erano nel tuo JS client)
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
        g = Math.max(0, Math.min(255, g));
        b = Math.max(0, Math.min(255, b));
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).padStart(6, '0').toUpperCase(); // Aggiunto padStart per sicurezza
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
    // === LEGGI IL PARAMETRO 'action' DALLA QUERY STRING ===
    const action = req.query.action; // Questo sarà 'renderStorePage' se viene da /negozio/:slug
    const slug = req.query.slug;     // Questo sarà lo slug del negozio

    // Aggiungi un log per debuggare l'azione ricevuta
    console.log(`[Vercel Function] Richiesta ricevuta. Action: "${action}", Slug: "${slug || 'N/A'}"`);

    // Usa uno switch per distinguere le azioni
    switch (action) {
        case 'renderStorePage':
            // --- LOGICA PER SERVIRE LA PAGINA DEL NEGOZIO ---
            // CORREZIONE: In Vercel non si usa res.set, ma si passa direttamente in res.send o si costruisce l'oggetto di risposta.
            // Impostiamo l'intestazione Content-Type nel secondo parametro di res.send.

            if (!slug) {
                console.error("Errore: slug non specificato per l'azione renderStorePage.");
                return res.status(404).send('<h1>404 Not Found</h1><p>Negozio non specificato nell\'URL.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
            }

            try {
                // 1. Trova il venditore nel database usando lo slug
                const vendorsRef = db.collection('vendors');
                const querySnapshot = await vendorsRef.where('slug', '==', slug).limit(1).get();

                if (querySnapshot.empty) {
                    console.warn(`Venditore con slug "${slug}" non trovato.`);
                    return res.status(404).send('<h1>404 Not Found</h1><p>Il negozio che cerchi non esiste su Civora.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
                }

                const vendorDoc = querySnapshot.docs[0];
                const vendorData = vendorDoc.data();
                const vendorId = vendorDoc.id; // L'ID effettivo del documento del venditore
                const shopColor = vendorData.shopColor || '#FF6600'; // Colore di default Civora se non specificato
                const userType = vendorData.userType || 'negoziante'; // Tipo di negoziante per scegliere la pagina giusta

                // 2. Determina la versione mobile o desktop della pagina HTML
                const userAgent = req.headers['user-agent'] || '';
                const isMobileDevice = isMobile(userAgent);

                // Determina il nome base del file HTML basandoti su userType
                let pageNameBase = 'vendor_store_detail'; 
                switch (userType) {
                    case 'alimentari':
                        pageNameBase = 'alimentari_detail';
                        break;
                    case 'mercato_fresco':
                        pageNameBase = 'mercato_fresco_detail';
                        break;
                    case 'noleggio': // O il tuo tipo per noleggio
                        pageNameBase = 'sezione_noleggio_facile/noleggio_desktop'; // Il tuo file noleggio_desktop.html è in una sottocartella
                        break;
                    case 'used_negoziante': // Per i negozi di usato
                        pageNameBase = 'used_vendor_store_detail';
                        break;
                    // Aggiungi altri casi per altri userType se hanno pagine di dettaglio diverse
                    default:
                        pageNameBase = 'vendor_store_detail'; 
                        break;
                }

                let htmlFileName;
                // La logica per i suffissi _mobile/_desktop o nessuna suffisso per desktop "implicito"
                if (isMobileDevice) {
                    // Per mobile, cerchiamo sempre il suffisso _mobile
                    // Eccezione: per `noleggio_desktop.html` in sezione_noleggio_facile, la mobile è `noleggio_mobile.html`
                    if (pageNameBase === 'sezione_noleggio_facile/noleggio_desktop') {
                        htmlFileName = 'sezione_noleggio_facile/noleggio_mobile.html';
                    } else {
                        htmlFileName = `${pageNameBase}_mobile.html`;
                    }
                } else {
                    // Per desktop, alcune pagine non hanno il suffisso _desktop (es. alimentari_detail.html)
                    // Usiamo il nome base SENZA suffisso se non esiste _desktop (come il tuo alimentari_detail.html)
                    // Se invece esiste una versione _desktop (come vendor_store_detail_desktop.html), usiamo quella.
                    // Questa logica assume che il file senza suffisso sia la versione desktop per alcuni tipi.
                    // Adattiamo la logica basandoci sulla lista dei tuoi file.
                    if (['alimentari_detail', 'mercato_fresco_detail'].includes(pageNameBase)) {
                        htmlFileName = `${pageNameBase}.html`; // Desktop "implicito"
                    } else if (pageNameBase === 'sezione_noleggio_facile/noleggio_desktop') {
                        htmlFileName = 'sezione_noleggio_facile/noleggio_desktop.html'; // Percorso completo per noleggio
                    } else {
                        htmlFileName = `${pageNameBase}_desktop.html`; // Desktop "esplicito"
                    }
                }
                
                // Aggiungi un log per verificare il nome del file HTML che la funzione sta cercando di scaricare
                console.log(`[Vercel Function] Tentativo di scaricare HTML per userType "${userType}" (Dispositivo mobile: ${isMobileDevice}): ${htmlFileName}`);

                // 3. Scarica il file HTML del negozio dal tuo Firebase Hosting (FRONTEND_BASE_URL)
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
                    // Tentativo di fallback con la homepage di Civora per evitare pagina bianca
                    if (htmlResponse.status === 404) {
                        return res.status(404).send(`<h1>404 Not Found</h1><p>La pagina specifica per questo negozio non è stata trovata. (${htmlFileName})</p><p>Torna alla <a href="${frontendBaseUrl}">Homepage Civora</a></p>`, { headers: { 'Content-Type': 'text/html' } });
                    }
                    throw new Error(`Impossibile scaricare il file HTML: ${htmlResponse.statusText}`);
                }
                let htmlContent = await htmlResponse.text();

                // 4. Prepara lo stile dinamico con i colori del negoziante
                const vendorColors = generateVendorColors(shopColor);
                const dynamicStyle = `
                    <style id="vendor-dynamic-styles">
                        :root {
                            --vendor-primary-color: ${vendorColors.primary};
                            --vendor-primary-light: ${vendorColors.light};
                            --vendor-primary-dark: ${vendorColors.dark};
                            --vendor-primary-gradient: ${vendorColors.gradient};
                            --price-color: ${vendorColors.primary}; /* Adatta come desideri */
                        }
                    </style>
                `;

                // 5. Inietta lo stile dinamico nell'HTML e i parametri ID e COLOR
                // Cerca il segnaposto '<!-- VENDOR_STYLE_INJECTION -->' e sostituiscilo
                htmlContent = htmlContent.replace('<!-- VENDOR_STYLE_INJECTION -->', dynamicStyle);

                // Aggiungiamo anche l'ID del venditore e il colore come data attributes al body
                // Questo è utile per la logica JS lato client che potrebbe aver bisogno dell'ID o del colore
                htmlContent = htmlContent.replace('<body', `<body data-vendor-id="${vendorId}" data-vendor-color="${shopColor}"`);

                // 6. Invia la pagina HTML modificata all'utente
                return res.status(200).send(htmlContent, { headers: { 'Content-Type': 'text/html' } });

            } catch (error) {
                console.error("[Vercel Function] Errore critico nel rendere la pagina del negozio:", error);
                return res.status(500).send('<h1>500 Internal Server Error</h1><p>Si è verificato un problema tecnico inaspettato nel caricamento del negozio.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
            }

        case undefined: // Questa è l'azione di default, se non specificata (quindi, una richiesta cron)
        case null:
        case 'cleanExpiredOffers': // Se in futuro vogliamo un'azione esplicita per la pulizia
            // --- LOGICA ESISTENTE PER LA PULIZIA CRON (COME PRIMA) ---
            // Blocco di sicurezza: solo Vercel Cron può eseguire questa funzione
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
                // 1. Trova tutte le offerte la cui data di fine è passata
                const expiredByDateQuery = db.collection('alimentari_offers').where('endDate', '<', now);
                const expiredByDateSnapshot = await expiredByDateQuery.get();

                expiredByDateSnapshot.forEach(doc => {
                    console.log(`⏳ Trovata offerta scaduta per data: ${doc.id}`);
                    const offerData = doc.data();
                    const expiredOfferRef = db.collection('expired_offers_trash').doc(doc.id);
                    
                    // Aggiungi l'offerta al "cestino"
                    batch.set(expiredOfferRef, { ...offerData, expiredAt: now, reason: 'Date Expired' });
                    // Elimina l'offerta dalla collezione attiva
                    batch.delete(doc.ref);
                    movedOffersCount++;
                });

                // 2. Trova tutte le offerte con quantità esaurita (quantity <= 0)
                const expiredByQuantityQuery = db.collection('alimentari_offers').where('quantity', '<=', 0);
                const expiredByQuantitySnapshot = await expiredByQuantityQuery.get();
                
                expiredByQuantitySnapshot.forEach(doc => {
                    // Controlla se l'abbiamo già spostata per la data, per non fare doppi conteggi
                    if (!expiredByDateSnapshot.docs.some(d => d.id === doc.id)) {
                        console.log(`🗑️ Trovata offerta con quantità esaurita: ${doc.id}`);
                        const offerData = doc.data();
                        const expiredOfferRef = db.collection('expired_offers_trash').doc(doc.id);
                        
                        batch.set(expiredOfferRef, { ...offerData, expiredAt: now, reason: 'Quantity Depleted' });
                        batch.delete(doc.ref);
                        movedOffersCount++;
                    }
                });

                // Esegui tutte le operazioni in un colpo soloo
                if (movedOffersCount > 0) {
                    await batch.commit();
                    console.log(`✅ Successo! Spostate ${movedOffersCount} offerte nel cestino.`);
                } else {
                    console.log("👍 Nessuna offerta scaduta da pulire oggi.");
                }

                // Rispondi con successo
                return res.status(200).json({ success: true, message: `Spostate ${movedOffersCount} offerte nel cestino.` });

            } catch (error) {
                console.error("❌ Errore durante la pulizia delle offerte:", error);
                return res.status(500).json({ success: false, error: error.message });
            }

        default:
            // Se l'azione non è riconosciuta
            console.warn(`[Vercel Function] Azione non riconosciuta: "${action}"`);
            return res.status(400).send('<h1>400 Bad Request</h1><p>Azione Vercel Function non valida.</p><p>Torna alla <a href="https://www.civora.it">Homepage Civora</a></p>', { headers: { 'Content-Type': 'text/html' } });
    }
};
