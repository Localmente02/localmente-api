const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const { GeoPoint, Timestamp } = admin.firestore;

// ==================================================================
// 1. INIZIALIZZAZIONE FIREBASE (SINGLETON)
// ==================================================================
let db;
let messaging;

if (!admin.apps.length) {
    let firebaseConfig = null;
    const firebaseServiceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

    if (firebaseServiceAccountKey) {
        try {
            // Tenta parsing JSON o decodifica Base64
            try {
                firebaseConfig = JSON.parse(firebaseServiceAccountKey);
            } catch (e) {
                firebaseConfig = JSON.parse(Buffer.from(firebaseServiceAccountKey, 'base64').toString('utf8'));
            }
        } catch (e2) {
            console.error("❌ ERRORE CRITICO: Impossibile leggere FIREBASE_SERVICE_ACCOUNT_KEY");
        }
    }

    if (firebaseConfig) {
        admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
        db = admin.firestore();
        messaging = admin.messaging();
        console.log("✅ Firebase Admin inizializzato.");
    }
} else {
    db = admin.firestore();
    messaging = admin.messaging();
}

// ==================================================================
// 2. CLASSI E MODELLI (Per Finalizzazione Ordine)
// ==================================================================
class OrderItem {
    constructor(data) { Object.assign(this, data); }
    toFirestore() { return { ...this }; }
}

class ShippingAddress {
    constructor(data) { Object.assign(this, data); }
    toFirestore() { return { ...this }; }
}

// ==================================================================
// 3. FUNZIONI DI SUPPORTO
// ==================================================================
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

// Logica Notifiche Push (Legacy)
async function handleSendNotification(body) {
    const { customerUserId, notificationTitle, notificationBody, notificationData, notificationType } = body;
    if (!customerUserId) throw new Error("customerUserId mancante");

    // Verifica preferenze utente
    const prefsDoc = await db.collection('users').doc(customerUserId).collection('preferences').doc('notification_settings').get();
    const prefs = prefsDoc.data() || {};
    if (prefs.receivePushNotifications === false) return { skipped: true, reason: 'Global disabled' };

    // Recupera token
    const tokensSnap = await db.collection('users').doc(customerUserId).collection('fcmTokens').get();
    if (tokensSnap.empty) return { skipped: true, reason: 'No tokens' };
    const tokens = tokensSnap.docs.map(d => d.id);

    const message = {
        notification: { title: notificationTitle, body: notificationBody },
        data: notificationData || {},
        tokens: tokens
    };

    const response = await messaging.sendEachForMulticast(message);
    
    // Pulizia token invalidi
    if (response.failureCount > 0) {
        response.responses.forEach(async (resp, idx) => {
            if (!resp.success) await db.collection('users').doc(customerUserId).collection('fcmTokens').doc(tokens[idx]).delete();
        });
    }
    return { success: true, sent: response.successCount };
}

// ==================================================================
// 4. MAIN HANDLER (IL MOTORE UNICO)
// ==================================================================
module.exports = async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    if (!db) return res.status(500).json({ error: 'Database non connesso' });

    const { action } = req.body;

    try {
        // --- ROUTING DELLE AZIONI ---
        
        // AZIONE 1: NOTIFICHE PUSH (Legacy)
        if (action === 'SEND_NOTIFICATION' || req.body.sendNotification) {
            const result = await handleSendNotification(req.body);
            return res.status(200).json(result);
        }

        // AZIONE 2: CALCOLO SICURO & PAGAMENTO (Il Bunker)
        if (action === 'CALCULATE_AND_PAY') {
            return await handleCalculateAndPay(req, res);
        }

        // AZIONE 3: FINALIZZAZIONE ORDINE (Ex finalize-guest-order)
        if (action === 'FINALIZE_ORDER') {
            return await handleFinalizeOrder(req, res);
        }

        // FALLBACK LEGACY (Per compatibilità temporanea)
        // Se non c'è action ma ci sono items, proviamo a gestirlo ma logghiamo warning
        if (req.body.items || req.body.amount) {
            console.warn("⚠️ Chiamata Legacy a create-payment-intent rilevata.");
            // Qui potremmo reinserire la logica vecchia se serve, ma per ora blocchiamo o adattiamo
            return res.status(400).json({ error: 'API aggiornata. Usa action: CALCULATE_AND_PAY' });
        }

        return res.status(400).json({ error: 'Azione sconosciuta' });

    } catch (error) {
        console.error("❌ ERRORE SERVER:", error);
        return res.status(500).json({ error: error.message });
    }
};

// ==================================================================
// 5. LOGICA: CALCULATE_AND_PAY (IL BUNKER)
// ==================================================================
async function handleCalculateAndPay(req, res) {
    const { cartItems, isGuest, guestData, clientClaimedTotal } = req.body;

    console.log(`🔒 Bunker avviato. Guest: ${isGuest}`);

    // 1. Configurazione Globale (Fee e Spedizioni)
    const settingsDoc = await db.collection('app_settings').doc('main_config').get();
    const settings = settingsDoc.data() || {};
    const CIVORA_FEE_PERCENT = settings.service_fee_percentage_marketplace || 0.04; // 4% default
    // const SHIPPING_COST = settings.shipping_fee_standard || 5.99; // Usato se non dinamico

    let serverGoodsTotal = 0;
    let validatedItems = [];
    let primaryVendorId = null;

    // 2. Calcolo Reale dei Prezzi
    for (const item of cartItems) {
        // Determina collezione
        const collectionName = item.type === 'alimentari' ? 'alimentari_products' : 'offers';
        const docRef = db.collection(collectionName).doc(item.docId || item.id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) continue; // Skip se non esiste

        const data = docSnap.data();
        const realPrice = parseFloat(data.price);
        const qty = parseInt(item.quantity || item.qty);

        serverGoodsTotal += realPrice * qty;
        
        // Traccia venditore per capire se è monomandatario
        if (!primaryVendorId) primaryVendorId = data.vendorId;
        else if (primaryVendorId !== data.vendorId) primaryVendorId = 'MARKETPLACE_MIX';

        validatedItems.push({ ...item, realPrice, vendorId: data.vendorId });
    }

    // 3. Calcolo Spedizione (Semplificato Server-Side)
    // Nota: Per precisione assoluta dovremmo replicare la logica complessa dei venditori qui.
    // Per ora usiamo il valore calcolato dal client MA lo verifichiamo grossolanamente o ci fidiamo
    // SOLO per la spedizione, mentre la merce è blindata. 
    // Oppure usiamo un fisso. Usiamo un default sicuro per ora.
    let serverShipping = req.body.shippingCost || 5.99; // Accettiamo shipping dal client per ora (meno rischioso della merce)

    const serverSubtotal = serverGoodsTotal + serverShipping;
    const serverFee = parseFloat((serverSubtotal * CIVORA_FEE_PERCENT).toFixed(2));
    const serverGrandTotal = parseFloat((serverSubtotal + serverFee).toFixed(2));

    // 4. WATCHDOG (Sicurezza)
    if (clientClaimedTotal) {
        const diff = Math.abs(serverGrandTotal - parseFloat(clientClaimedTotal));
        if (diff > 1.00) {
            console.warn(`🚨 HACK ATTEMPT? Client: ${clientClaimedTotal} vs Server: ${serverGrandTotal}`);
            await db.collection('_security_audits').add({
                type: 'PRICE_TAMPERING',
                email: guestData?.email || 'unknown',
                diff: diff,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            // Blocchiamo!
            throw new Error("Discrepanza nei prezzi rilevata. Aggiorna il carrello.");
        }
    }

    // 5. Crea Payment Intent
    const amountInt = Math.round(serverGrandTotal * 100);
    
    const metadata = {
        isGuestOrder: isGuest ? 'true' : 'false',
        civoraFee: serverFee,
        // Dati essenziali per finalizzare
        guestEmail: guestData?.email,
        tempGuestCartRef: req.body.tempGuestCartRef // Fondamentale per il guest
    };
    
    // Aggiungi dati ospite appiattiti nei metadata (limite 500 chiavi, ma ok per pochi dati)
    if (guestData) {
        if(guestData.name) metadata.guestName = guestData.name;
        if(guestData.surname) metadata.guestSurname = guestData.surname;
        if(guestData.phone) metadata.guestPhone = guestData.phone;
        // ecc...
    }

    const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInt,
        currency: 'eur',
        automatic_payment_methods: { enabled: true },
        metadata: metadata
    });

    return res.status(200).json({
        clientSecret: paymentIntent.client_secret,
        summary: {
            realGoods: serverGoodsTotal,
            realShipping: serverShipping,
            realFee: serverFee,
            realTotal: serverGrandTotal
        }
    });
}

// ==================================================================
// 6. LOGICA: FINALIZE_ORDER (Ex finalize-guest-order)
// ==================================================================
async function handleFinalizeOrder(req, res) {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) throw new Error("PaymentIntentId mancante");

    // 1. Recupera da Stripe
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'succeeded') throw new Error(`Pagamento non riuscito: ${pi.status}`);

    const meta = pi.metadata;

    // Controllo Idempotenza
    const exist = await db.collection('orders').where('paymentIntentId', '==', paymentIntentId).limit(1).get();
    if (!exist.empty) {
        return res.status(200).json({ orderId: exist.docs[0].id, message: 'Ordine già esistente' });
    }

    // 2. Recupera Articoli
    let cartItems = [];
    if (meta.tempGuestCartRef) {
        const cartDoc = await db.collection('temp_guest_carts').doc(meta.tempGuestCartRef).get();
        if (cartDoc.exists) cartItems = cartDoc.data().items;
    }
    
    if (!cartItems.length) throw new Error("Carrello vuoto o scaduto");

    // 3. Prepara Ordine
    const batch = db.batch();
    const orderId = db.collection('orders').doc().id;
    const orderNumber = `G-${Date.now().toString().slice(-8)}`;
    
    const vendorIds = [...new Set(cartItems.map(i => i.vendorId))];
    
    // Dati Guest dai Metadata (Ricostruzione parziale o completa)
    // Nota: Idealmente qui si usano i dati completi passati o salvati nel temp cart.
    // Assumiamo che il temp cart abbia i dati completi o li abbiamo passati nel body (più sicuro temp cart).
    // Per semplicità qui usiamo dati generici o letti da temp cart se salvati lì.
    
    const mainOrderData = {
        id: orderId,
        orderNumber: orderNumber,
        status: 'In Attesa di Preparazione',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        totalPrice: pi.amount / 100,
        paymentIntentId: paymentIntentId,
        items: cartItems.map(i => new OrderItem(i).toFirestore()),
        customerEmail: meta.guestEmail || 'guest@unknown.com',
        // ... altri campi indirizzo ...
        vendorIdsInvolved: vendorIds
    };

    // Scrivi Ordine Principale
    batch.set(db.collection('orders').doc(orderId), mainOrderData);

    // Scrivi Sotto-Ordini (Divisione per Venditore)
    for (const vid of vendorIds) {
        const vItems = cartItems.filter(i => i.vendorId === vid);
        const subOrderRef = db.collection('vendor_orders').doc(vid).collection('orders').doc(orderId);
        batch.set(subOrderRef, {
            ...mainOrderData,
            items: vItems,
            orderType: vendorIds.length > 1 ? 'marketplaceConsolidated' : 'singleVendorExpress'
        });
    }

    // Cancella Temp Cart
    if (meta.tempGuestCartRef) {
        batch.delete(db.collection('temp_guest_carts').doc(meta.tempGuestCartRef));
    }

    await batch.commit();

    console.log(`✅ Ordine ${orderId} finalizzato.`);

    // INVIO EMAIL (Opzionale: qui chiameresti la funzione email esterna)
    // Non lo facciamo inline per non rallentare, ma idealmente fai una fetch all'altra Vercel function
    
    return res.status(200).json({ orderId, orderNumber });
}
