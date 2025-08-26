// File: api/orchestrator.js
// IL CERVELLO UNICO DI LOCALMENTE - Versione Completa

// --- 1. INIZIALIZZAZIONI COMUNI (UNA SOLA VOLTA) ---
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const OpenAI = require('openai');
const ImageKit = require('imagekit');
const fetch = require('node-fetch');
const translate = require('@iamtraction/google-translate');

// Inizializzazione Firebase Admin
let db;
if (!admin.apps.length) {
  try {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
    db = admin.firestore();
    console.log("Firebase Admin SDK inizializzato con successo nell'Orchestrator.");
  } catch (e) {
    console.error('ERRORE Inizializzazione Firebase Admin:', e.message);
  }
} else {
  db = admin.firestore();
}

// Inizializzazione OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// --- 2. LOGICA DI OGNI FUNZIONE (I "DIPARTIMENTI") ---

// --- DIPARTIMENTO PAGAMENTI: create-payment-intent.js ---
async function handleCreatePaymentIntent(req, res) {
    console.log("Orchestrator: Gestione Create Payment Intent...");
    try {
        const { amount, currency, description, stripeAccountId, applicationFeeAmount, metadata } = req.body;
        if (!amount || !currency) {
            return res.status(400).json({ error: 'Missing amount or currency' });
        }
        
        // Usiamo la versione "NAKED" che hai detto essere quella giusta per il webhook
        const params = {
            amount: parseInt(amount),
            currency: currency,
            payment_method_types: ['card'],
            description: description || 'Ordine Localmente',
            metadata: metadata,
        };

        const paymentIntent = await stripe.paymentIntents.create(params);
        return res.status(200).json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        console.error('Errore in handleCreatePaymentIntent:', error);
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
}

// --- DIPARTIMENTO PAGAMENTI: create-stripe-account-link.js ---
async function handleCreateStripeAccountLink(req, res) {
    console.log("Orchestrator: Gestione Create Stripe Account Link...");
    try {
        const { accountId, refreshUrl, returnUrl, email, businessName } = req.body;
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express', country: 'IT', email: email,
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
                business_profile: { name: businessName },
            });
            const accountLink = await stripe.accountLinks.create({
                account: account.id, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
            });
            return res.status(200).json({ accountId: account.id, url: accountLink.url });
        } else {
            const accountLink = await stripe.accountLinks.create({
                account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
            });
            return res.status(200).json({ accountId: accountId, url: accountLink.url });
        }
    } catch (error) {
        console.error('Errore in handleCreateStripeAccountLink:', error);
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
}

// --- DIPARTIMENTO PAGAMENTI: get-stripe-balance-and-transactions.js ---
async function handleGetStripeBalance(req, res) {
    console.log("Orchestrator: Gestione Get Stripe Balance...");
    try {
        const { stripeAccountId } = req.query;
        if (!stripeAccountId) {
            return res.status(400).json({ error: 'Missing Stripe Account ID' });
        }
        const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
        const transactions = await stripe.balanceTransactions.list({ limit: 20, expand: ['data.source'] }, { stripeAccount: stripeAccountId });
        return res.status(200).json({ balance: balance, transactions: transactions.data });
    } catch (error) {
        console.error('Errore in handleGetStripeBalance:', error);
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
}

// --- DIPARTIMENTO PAGAMENTI: webhook.js ---
async function handleWebhook(req, res) {
    console.log("Orchestrator: Gestione Webhook...");
    // Il codice del tuo webhook.js va qui.
    // Per ora, mettiamo un placeholder. La gestione del raw body potrebbe essere delicata.
    console.log("Webhook ricevuto!", req.body);
    return res.status(200).json({ received: true });
}

// --- DIPARTIMENTO RICERCA E AI: gift-recommender.js / smart-search.js ---
const fetchAllFromCollection = async (collectionName, type) => {
    try {
        const snapshot = await db.collection(collectionName).get();
        if (snapshot.empty) return [];
        return snapshot.docs.map(doc => ({ id: doc.id, type, data: doc.data() }));
    } catch (error) {
        console.error(`Errore fetch collezione '${collectionName}':`, error);
        return [];
    }
};
async function handleSmartSearchAI(req, res) {
    console.log("Orchestrator: Gestione Ricerca AI (gift-recommender)...");
    try {
        let { userQuery } = req.body;
        if (!userQuery) {
            return res.status(400).json({ error: 'Manca userQuery nel body.' });
        }
        let translatedQuery = userQuery;
        try {
            const result = await translate(userQuery, { to: 'it' });
            translatedQuery = result.text;
        } catch (err) {
            console.error('Errore traduzione:', err);
        }
        const [products, vendors] = await Promise.all([
            fetchAllFromCollection('global_product_catalog', 'product'),
            fetchAllFromCollection('vendors', 'vendor'),
        ]);
        const relevantData = [...products, ...vendors];
        const systemPrompt = `Sei un assistente di ricerca molto amichevole per una piattaforma e-commerce locale chiamata "Localmente". Il tuo compito è aiutare gli utenti a trovare prodotti, servizi e attività nel database che ti passo. Rispondi SEMPRE in italiano, con tono positivo e utile, come un commesso esperto che consiglia. Non inventare nulla: usa solo i dati che ti vengono forniti.`;
        const userMessage = `Ecco la query dell'utente: "${translatedQuery}". Ecco i dati disponibili (JSON): ${JSON.stringify(relevantData)}. Genera una risposta naturale e utile, usando solo questi dati.`;
        const completion = await openai.chat.completions.create({
            model: "mistralai/mistral-7b-instruct",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
            temperature: 0.7, max_tokens: 300,
        });
        const aiResponse = completion.choices[0].message.content;
        return res.status(200).json({ query: translatedQuery, aiResponse, rawData: relevantData });
    } catch (error) {
        console.error('ERRORE in handleSmartSearchAI:', error);
        return res.status(500).json({ error: 'Errore interno', details: error.message });
    }
}

// --- DIPARTIMENTO UTILITA': get-crypto-exchange-rate.js ---
const COINGECKO_IDS = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'USDC': 'usd-coin' };
async function handleGetCryptoRate(req, res) {
    console.log("Orchestrator: Gestione Tasso Crypto...");
    try {
        const { currencyCode } = req.query;
        if (!currencyCode) {
            return res.status(400).json({ error: 'Missing currencyCode parameter.' });
        }
        const coingeckoId = COINGECKO_IDS[currencyCode.toUpperCase()];
        if (!coingeckoId) {
            return res.status(404).json({ error: `Currency code '${currencyCode}' not supported.` });
        }
        const coingeckoApiUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=eur`;
        const response = await fetch(coingeckoApiUrl);
        const data = await response.json();
        const cryptoData = data[coingeckoId];
        if (cryptoData && cryptoData.eur) {
            const rateEurPerCrypto = cryptoData.eur;
            const rateCryptoPerEur = 1 / rateEurPerCrypto;
            return res.status(200).json({ currencyCode: currencyCode, fiatCurrency: 'EUR', rate: rateCryptoPerEur });
        } else {
            return res.status(404).json({ error: `Exchange rate not found for ${currencyCode} to EUR.` });
        }
    } catch (error) {
        console.error('Errore in handleGetCryptoRate:', error);
        return res.status(500).json({ error: 'Failed to fetch crypto exchange rate.', details: error.message });
    }
}

// --- DIPARTIMENTO UTILITA': generate-imagekit-token.js ---
async function handleGenerateImagekitToken(req, res) {
    console.log("Orchestrator: Gestione Token ImageKit...");
    try {
        const configDoc = await db.collection('config_private').doc('BucTmeGHsIP48iX2a561').get();
        if (!configDoc.exists) {
            throw new Error("Documento di configurazione non trovato in Firestore.");
        }
        const configData = configDoc.data();
        const { imagekitPrivateKey, imagekitPublicKey, imagekitUrlEndpoint } = configData;
        if (!imagekitPrivateKey || !imagekitPublicKey || !imagekitUrlEndpoint) {
            throw new Error("Credenziali di ImageKit mancanti nel documento di configurazione.");
        }
        const imagekit = new ImageKit({
            privateKey: imagekitPrivateKey, publicKey: imagekitPublicKey, urlEndpoint: imagekitUrlEndpoint,
        });
        const authenticationParameters = imagekit.getAuthenticationParameters();
        return res.status(200).json(authenticationParameters);
    } catch (error) {
        console.error("Errore nella generazione del token di ImageKit:", error);
        return res.status(500).json({ error: 'Impossibile generare il token di autenticazione.', details: error.message });
    }
}

// --- DIPARTIMENTO CRON: clean_expired_offers.js ---
async function handleCleanExpiredOffers(req, res) {
    console.log("Orchestrator (CRON): Gestione Pulizia Offerte Scadute...");
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'Accesso non autorizzato.' });
    }
    const now = admin.firestore.Timestamp.now();
    let movedOffersCount = 0;
    const batch = db.batch();
    try {
        const expiredByDateQuery = db.collection('alimentari_offers').where('endDate', '<', now);
        const expiredByDateSnapshot = await expiredByDateQuery.get();
        expiredByDateSnapshot.forEach(doc => {
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
                const offerData = doc.data();
                const expiredOfferRef = db.collection('expired_offers_trash').doc(doc.id);
                batch.set(expiredOfferRef, { ...offerData, expiredAt: now, reason: 'Quantity Depleted' });
                batch.delete(doc.ref);
                movedOffersCount++;
            }
        });
        if (movedOffersCount > 0) {
            await batch.commit();
        }
        return res.status(200).json({ success: true, message: `Spostate ${movedOffersCount} offerte nel cestino.` });
    } catch (error) {
        console.error("Errore durante la pulizia delle offerte:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

// --- DIPARTIMENTO CRON: update_vehicle_status.js ---
async function handleUpdateVehicleStatus(req, res) {
    console.log("Orchestrator (CRON): Gestione Aggiornamento Stato Veicoli...");
    try {
        const now = admin.firestore.Timestamp.now();
        const activeBookingsSnapshot = await db.collection('bookings').where('type', '==', 'noleggio').where('status', '==', 'confirmed').where('startDateTime', '<=', now).get();
        const rentedVehicleIds = new Set();
        activeBookingsSnapshot.forEach(doc => {
            const booking = doc.data();
            if (booking.endDateTime.toDate() > now.toDate()) {
                rentedVehicleIds.add(booking.serviceId);
            }
        });
        const allVehiclesSnapshot = await db.collection('noleggio_veicoli').get();
        const batch = db.batch();
        let updatesCounter = 0;
        allVehiclesSnapshot.forEach(doc => {
            const vehicleId = doc.id;
            const currentStatus = doc.data().status;
            const vehicleRef = db.collection('noleggio_veicoli').doc(vehicleId);
            if (rentedVehicleIds.has(vehicleId)) {
                if (currentStatus !== 'rented') {
                    batch.update(vehicleRef, { status: 'rented' });
                    updatesCounter++;
                }
            } else {
                if (currentStatus !== 'available') {
                    batch.update(vehicleRef, { status: 'available' });
                    updatesCounter++;
                }
            }
        });
        if (updatesCounter > 0) {
            await batch.commit();
            return res.status(200).send(`Stato di ${updatesCounter} veicoli aggiornato.`);
        } else {
            return res.status(200).send('Nessun aggiornamento di stato necessario.');
        }
    } catch (error) {
        console.error('ERRORE nel cron job updateVehicleStatus:', error);
        return res.status(500).send(`Errore durante l'esecuzione del cron job: ${error.message}`);
    }
}

// --- DIPARTIMENTO BOOKING: get-available-slots.js ---
async function handleGetAvailableSlots(req, res) {
    console.log("Orchestrator: Gestione Get Available Slots...");
    try {
        const { bookingType, vendorId } = req.body;
        if (bookingType === 'rental_fleet_check') {
            const { startDate, endDate } = req.body;
            if (!vendorId || !startDate || !endDate) return res.status(400).json({ error: 'Dati mancanti per la verifica della flotta.' });
            const start = new Date(startDate);
            const end = new Date(endDate);
            const vehiclesSnapshot = await db.collection('noleggio_veicoli').where('vendorId', '==', vendorId).get();
            if (vehiclesSnapshot.empty) return res.status(200).json({ availableVehicles: [], unavailableVehicles: [] });
            const allVehicles = vehiclesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const allVehicleIds = allVehicles.map(v => v.id);
            const bookingsSnapshot = await db.collection('bookings').where('vendorId', '==', vendorId).where('serviceId', 'in', allVehicleIds).where('type', '==', 'noleggio').where('status', '==', 'confirmed').get();
            const conflictingBookings = bookingsSnapshot.docs.map(doc => {
                const booking = doc.data();
                const bookingStart = booking.startDateTime.toDate();
                const bookingEnd = booking.endDateTime.toDate();
                if (start < bookingEnd && end > bookingStart) return { vehicleId: booking.serviceId, customerName: booking.customerName, endDate: bookingEnd.toISOString().split('T')[0] };
                return null;
            }).filter(Boolean);
            const unavailableVehicleIds = new Set(conflictingBookings.map(b => b.vehicleId));
            const availableVehicles = allVehicles.filter(v => !unavailableVehicleIds.has(v.id)).map(v => ({ id: v.id, model: v.model, price: v.pricePerDay }));
            const unavailableVehicles = allVehicles.filter(v => unavailableVehicleIds.has(v.id)).map(v => {
                const conflict = conflictingBookings.find(b => b.vehicleId === v.id);
                return { id: v.id, model: v.model, conflictInfo: `Prenotato da ${conflict.customerName} fino al ${new Date(conflict.endDate).toLocaleDateString('it-IT')}` };
            });
            return res.status(200).json({ availableVehicles, unavailableVehicles });
        } else {
            const { serviceId, date } = req.body;
            if (!vendorId || !serviceId || !date) return res.status(400).json({ error: 'Dati mancanti per la verifica del servizio.' });
            const [serviceDoc, vendorDoc, resourcesSnapshot, bookingsSnapshot] = await Promise.all([
                db.collection('offers').doc(serviceId).get(),
                db.collection('vendors').doc(vendorId).get(),
                db.collection('vendors').doc(vendorId).collection('resources').get(),
                db.collection('bookings').where('vendorId', '==', vendorId).where('startDateTime', '>=', new Date(date + 'T00:00:00Z')).where('startDateTime', '<=', new Date(date + 'T23:59:59Z')).get()
            ]);
            if (!serviceDoc.exists || !serviceDoc.data().serviceDuration) return res.status(404).json({ error: 'Servizio non trovato o senza durata.' });
            const serviceData = serviceDoc.data();
            const serviceDuration = serviceData.serviceDuration;
            const requirements = serviceData.requirements || [];
            if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) return res.status(200).json({ slots: [], message: 'Orari non configurati.' });
            const dateObj = new Date(date + 'T00:00:00Z');
            const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
            const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);
            if (!todayHours || !todayHours.isOpen) return res.status(200).json({ slots: [], message: 'Negozio chiuso.' });
            const allResources = resourcesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const existingBookings = bookingsSnapshot.docs.map(doc => ({ start: doc.data().startDateTime.toDate(), end: doc.data().endDateTime.toDate(), assignedResourceIds: doc.data().assignedResourceIds || [] }));
            const availableSlots = [];
            const slotIncrement = 15;
            for (const slot of todayHours.slots) {
                if (!slot.from || !slot.to) continue;
                const [startHour, startMinute] = slot.from.split(':').map(Number);
                const [endHour, endMinute] = slot.to.split(':').map(Number);
                let currentTime = new Date(date + 'T00:00:00Z');
                currentTime.setUTCHours(startHour, startMinute, 0, 0);
                const endOfWorkSlot = new Date(date + 'T00:00:00Z');
                endOfWorkSlot.setUTCHours(endHour, endMinute, 0, 0);
                while (currentTime < endOfWorkSlot) {
                    const potentialEndTime = new Date(currentTime.getTime() + serviceDuration * 60000);
                    if (potentialEndTime > endOfWorkSlot) break;
                    let areAllRequirementsMet = true;
                    if (requirements.length > 0) {
                        for (const req of requirements) {
                            const resourcesInGroup = allResources.filter(r => r.groupId === req.groupId);
                            const availableResourcesInGroup = resourcesInGroup.filter(resource => !existingBookings.some(booking => booking.assignedResourceIds.includes(resource.id) && (currentTime < booking.end && potentialEndTime > booking.start)));
                            if (availableResourcesInGroup.length < req.quantity) { areAllRequirementsMet = false; break; }
                        }
                    } else {
                        if (existingBookings.some(booking => currentTime < booking.end && potentialEndTime > booking.start)) areAllRequirementsMet = false;
                    }
                    if (areAllRequirementsMet) {
                        const hours = String(currentTime.getUTCHours()).padStart(2, '0');
                        const minutes = String(currentTime.getUTCMinutes()).padStart(2, '0');
                        availableSlots.push(`${hours}:${minutes}`);
                    }
                    currentTime.setUTCMinutes(currentTime.getUTCMinutes() + slotIncrement);
                }
            }
            return res.status(200).json({ slots: availableSlots });
        }
    } catch (error) {
        console.error('Errore in get-available-slots:', error);
        return res.status(500).json({ error: 'Errore interno del server.', details: error.message });
    }
}


// --- 3. IL CENTRALINISTA (LA FUNZIONE PRINCIPALE) ---
module.exports = async (req, res) => {
    const path = req.url.split('?')[0];
    console.log(`Richiesta in arrivo a Orchestrator per: ${path} [${req.method}]`);
    
    // Gestione CORS una volta per tutte
    res.setHeader('Access-Control-Allow-Origin', '*'); // O specifica i tuoi domini
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Il nostro switch che instrada la chiamata al dipartimento giusto
    switch (path) {
        // PAGAMENTI
        case '/api/create-payment-intent': return await handleCreatePaymentIntent(req, res);
        case '/api/create-stripe-account-link': return await handleCreateStripeAccountLink(req, res);
        case '/api/get-stripe-balance-and-transactions': return await handleGetStripeBalance(req, res);
        case '/api/webhook': return await handleWebhook(req, res);
        
        // RICERCA
        case '/api/gift-recommender':
        case '/api/smart-search':
            return await handleSmartSearchAI(req, res);
            
        // UTILITA'
        case '/api/get-crypto-exchange-rate': return await handleGetCryptoRate(req, res);
        case '/api/generate-imagekit-token': return await handleGenerateImagekitToken(req, res);
            
        // BOOKING
        case '/api/get-available-slots': return await handleGetAvailableSlots(req, res);
            
        // CRON JOBS
        case '/api/clean_expired_offers': return await handleCleanExpiredOffers(req, res);
        case '/api/update_vehicle_status': return await handleUpdateVehicleStatus(req, res);

        default:
            return res.status(404).json({ error: `Endpoint non gestito dall'Orchestrator: ${path}` });
    }
};
