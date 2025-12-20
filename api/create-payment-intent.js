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
// 2. CLASSI E MODELLI (Per Finalizzazione Ordine) - Potrebbero non essere strettamente necessari se i dati sono già flat.
// ==================================================================
// Lasciati per compatibilità o se il tuo codice li usa altrove, ma l'assegnazione diretta da oggetti funziona.
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

// Funzione helper per determinare se due date sono lo stesso giorno (necessaria per il contatore spedizioni gratuite)
function isSameDay(date1, date2) {
    const d1 = date1 instanceof Date ? date1 : date1.toDate(); // Converte Timestamp se necessario
    const d2 = date2 instanceof Date ? date2 : date2.toDate(); // Converte Timestamp se necessario

    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
}


// Logica Notifiche Push (Legacy - ma ancora usata per SEND_NOTIFICATION action)
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

        // FALLBACK LEGACY (Per compatibilità temporanea - blocchiamo come richiesto)
        // Se non c'è action ma ci sono items o amount, blocchiamo con un warning.
        if (req.body.items || req.body.amount) {
            console.warn("⚠️ Chiamata Legacy a create-payment-intent rilevata. Blocchiamo.");
            return res.status(400).json({ error: 'API aggiornata. Usa action: CALCULATE_AND_PAY o FINALIZE_ORDER' });
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
    const { cartItems, isGuest, guestData, clientClaimedTotal, tempGuestCartRef, vendorId } = req.body; // Aggiunto vendorId

    console.log(`🔒 Bunker avviato. Guest: ${isGuest}, Vendor: ${vendorId}`);

    // 1. Configurazione Globale (Fee e Spedizioni)
    const settingsDoc = await db.collection('app_settings').doc('main_config').get();
    const settings = settingsDoc.data() || {};
    
    // Tariffe per gli ospiti (fallback se non presenti)
    const GUEST_SHIPPING_FEE = settings.guest_shipping_fee_single_vendor || 3.99;
    const GUEST_SERVICE_FEE_PERCENTAGE = settings.guest_service_fee_percentage_single_vendor || 0.125;

    let serverGoodsTotal = 0;
    let validatedItems = [];
    let primaryVendorId = null; // Per identificare se è un ordine da un singolo venditore

    // 2. Calcolo Reale dei Prezzi e Validazione Articoli
    for (const item of cartItems) {
        // Determina collezione basandosi sul 'type' dell'item
        const collectionName = item.type === 'alimentari' ? 'alimentari_products' : 'offers'; // Assumo 'offers' come default generico
        const docRef = db.collection(collectionName).doc(item.docId || item.id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            console.warn(`Articolo non trovato nel DB: ${item.docId || item.id} nella collezione ${collectionName}. Saltato.`);
            // Potresti voler lanciare un errore qui se l'articolo è obbligatorio
            continue; 
        }

        const data = docSnap.data();
        const realPrice = parseFloat(data.price);
        const qty = parseInt(item.quantity);

        serverGoodsTotal += realPrice * qty;
        
        // Traccia venditore per capire se è monomandatario o marketplace
        if (!primaryVendorId) primaryVendorId = data.vendorId;
        else if (primaryVendorId !== data.vendorId) primaryVendorId = 'MARKETPLACE_MIX'; // Segna come mix se i venditori sono diversi

        // Aggiungi al validatedItems solo i dati sicuri e arricchiti dal server
        validatedItems.push({ 
            ...item, 
            docId: item.docId || item.id, // Assicura che docId sia sempre presente
            productName: data.productName, // Aggiungi nome e altre info utili
            imageUrl: data.primaryImageUrl || data.productImageUrl || '/assets/placeholder_fallback_image.png',
            price: realPrice, // Prezzo reale dal database
            vendorId: data.vendorId, // Vendor ID reale dal database
            vendorStoreName: data.vendorStoreName || 'Sconosciuto', // Nome del negozio
            options: item.options || {}, // Mantieni le opzioni se presenti
            type: item.type // Tipo di collezione
        });
    }
    serverGoodsTotal = parseFloat(serverGoodsTotal.toFixed(2));


    // 3. Calcolo Spedizione (logica dettagliata)
    let serverShipping = GUEST_SHIPPING_FEE; // Partiamo dal costo base guest
    let isShippingFree = false;

    // Recupera i dati completi del venditore per le regole di spedizione gratuita
    const vendorDoc = await db.collection('vendors').doc(vendorId).get();
    const currentVendorFullData = vendorDoc.exists ? vendorDoc.data() : {};

    if (currentVendorFullData.aderisce_spedizioni_gratuite) {
        if (currentVendorFullData.free_shipping_type === 'min_order_value') {
            const minOrderValue = currentVendorFullData.free_shipping_min_order_value || 0;
            if (serverGoodsTotal >= minOrderValue) {
                serverShipping = 0;
                isShippingFree = true;
            }
        } else if (currentVendorFullData.free_shipping_type === 'daily_limit') {
            const limit = currentVendorFullData.free_shipping_limit || 0;
            const count = currentVendorFullData.contatore_spedizioni_gratuite || 0;
            const lastResetDate = currentVendorFullData.data_ultimo_reset_contatore ? currentVendorFullData.data_ultimo_reset_contatore : null;

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            let isCounterResetForToday = false;
            if (lastResetDate && isSameDay(lastResetDate, today)) {
                isCounterResetForToday = true;
            }

            if ((!isCounterResetForToday && limit > 0) || (isCounterResetForToday && count < limit)) {
                serverShipping = 0;
                isShippingFree = true;
            }
        }
    }
    serverShipping = parseFloat(serverShipping.toFixed(2));


    // 4. Calcolo Service Fee
    let serverFee = serverGoodsTotal * GUEST_SERVICE_FEE_PERCENTAGE; // Applica la percentuale guest
    serverFee = parseFloat(serverFee.toFixed(2));

    const serverGrandTotal = parseFloat((serverGoodsTotal + serverShipping + serverFee).toFixed(2));

    // 5. Aggiorna il carrello temporaneo con i totali calcolati in modo sicuro
    if (tempGuestCartRef) {
        const tempCartRef = db.collection('temp_guest_carts').doc(tempGuestCartRef);
        await tempCartRef.update({
            items: validatedItems, // Salva gli articoli validati e arricchiti
            subtotal: serverGoodsTotal,
            shippingCost: serverShipping,
            serviceFee: serverFee,
            totalPrice: serverGrandTotal,
            isShippingFree: isShippingFree,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            // Aggiungi qui altri dati utili per FINALIZE_ORDER se non sono nei metadata di PI
            // Es: guestData for shipping address if not passed again. (Meglio passarlo nel body di FINALIZE_ORDER)
        });
        console.log(`✅ Carrello ospite temporaneo ${tempGuestCartRef} aggiornato con totali sicuri.`);
    }


    // 6. WATCHDOG (Sicurezza) - Confronta il totale calcolato dal client con quello del server
    // solo se il client ha fornito un claimedTotal maggiore di 0 per evitare errori con 0-value
    if (clientClaimedTotal !== undefined && clientClaimedTotal > 0) { // clientClaimedTotal è in centesimi
        const diff = Math.abs(serverGrandTotal * 100 - clientClaimedTotal); // Confronta in centesimi
        if (diff > 100) { // Tolleranza di 1 euro (100 centesimi)
            console.warn(`🚨 HACK ATTEMPT? Client claimed: ${clientClaimedTotal/100} vs Server calculated: ${serverGrandTotal}`);
            await db.collection('_security_audits').add({
                type: 'PRICE_TAMPERING',
                email: guestData?.email || 'unknown',
                diff: diff / 100, // Logga la differenza in euro
                claimedTotal: clientClaimedTotal / 100,
                serverTotal: serverGrandTotal,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                cartItems: cartItems // Include il carrello per debug
            });
            throw new Error("Discrepanza nei prezzi rilevata. Aggiorna il carrello e riprova.");
        }
    }


    // 7. Crea Payment Intent di Stripe
    const amountInt = Math.round(serverGrandTotal * 100);
    
    // Per gli ordini guest, prendiamo l'ID del venditore dalla richiesta.
    const stripeAccountId = currentVendorFullData.stripeAccountId;
    if (!stripeAccountId) {
        throw new Error("Stripe Account ID del venditore non configurato.");
    }

    const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInt,
        currency: 'eur',
        automatic_payment_methods: { enabled: true },
        // Per Stripe Connect, specificare application_fee_amount e destination
        application_fee_amount: Math.round(serverFee * 100), // Commissione di Civora in centesimi
        transfer_data: {
            destination: stripeAccountId,
        },
        metadata: {
            isGuestOrder: 'true',
            civoraFee: serverFee.toString(),
            shippingCost: serverShipping.toString(),
            subTotal: serverGoodsTotal.toString(),
            totalPrice: serverGrandTotal.toString(),
            vendorId: vendorId, // ID del singolo venditore
            tempGuestCartRef: tempGuestCartRef // Fondamentale per la finalizzazione
        }
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
    const { paymentIntentId, guestData, tempGuestCartRef, vendorId, paymentMethod } = req.body;
    
    if (!paymentIntentId) throw new Error("PaymentIntentId mancante");
    if (!guestData) throw new Error("Dati ospite mancanti per la finalizzazione.");
    if (!tempGuestCartRef) throw new Error("Riferimento carrello ospite temporaneo mancante.");
    if (!vendorId) throw new Error("ID venditore mancante per la finalizzazione.");

    // 1. Recupera da Stripe (se non è un ordine FREE_ORDER)
    if (paymentIntentId !== 'FREE_ORDER') {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status !== 'succeeded') throw new Error(`Pagamento non riuscito: ${pi.status}. Stato attuale: ${pi.status}`);
    }

    // Controllo Idempotenza per evitare duplicati
    const exist = await db.collection('orders').where('paymentIntentId', '==', paymentIntentId).limit(1).get();
    if (!exist.empty) {
        console.warn(`Ordine per PaymentIntentId ${paymentIntentId} già esistente: ${exist.docs[0].id}. Ignoro finalizzazione duplicata.`);
        return res.status(200).json({ orderId: exist.docs[0].id, message: 'Ordine già esistente' });
    }

    // 2. Recupera Articoli e totali calcolati in modo sicuro dal temp_guest_carts
    const cartDocRef = db.collection('temp_guest_carts').doc(tempGuestCartRef);
    const cartDoc = await cartDocRef.get();

    if (!cartDoc.exists) {
        console.error(`Temp guest cart ${tempGuestCartRef} not found during finalization.`);
        throw new Error('Carrello ospite temporaneo non trovato o scaduto per la finalizzazione.');
    }
    const tempCartData = cartDoc.data();

    const itemsToOrder = tempCartData.items;
    const subtotal = tempCartData.subtotal;
    const shippingCost = tempCartData.shippingCost;
    const serviceFee = tempCartData.serviceFee;
    const totalPrice = tempCartData.totalPrice;
    const isShippingFree = tempCartData.isShippingFree;

    if (!itemsToOrder || itemsToOrder.length === 0) {
        console.error("Carrello vuoto o scaduto nel temp_guest_carts durante finalizzazione.");
        throw new Error("Carrello vuoto o scaduto.");
    }

    // 3. Recupera i dati completi del venditore per l'indirizzo di pickup e il userType
    const vendorDoc = await db.collection('vendors').doc(vendorId).get();
    if (!vendorDoc.exists) {
        console.error(`Vendor ${vendorId} not found during order finalization.`);
        throw new Error('Dettagli del negoziante non trovati per la finalizzazione.');
    }
    const currentVendorFullData = vendorDoc.data();

    // --- INIZIO MODIFICHE RICHIESTE ---

    // 1. Priorità e Tipo dell'Ordine (EXPRESS o CONSOLIDATO)
    // Per gli ordini guest, assumiamo sempre un singolo venditore
    const orderPriority = 'EXPRESS';
    const orderType = 'singleVendorExpress';
    const vendorIdsInvolved = [vendorId]; // Per ordine singolo, l'array contiene solo questo vendorId

    // 2. Struttura dell'indirizzo di spedizione
    const shippingAddress = {
        street: guestData.address,
        city: guestData.city,
        zipCode: guestData.cap,    // Nota: la dashboard cerca zipCode o zip
        province: guestData.province,
        country: guestData.country || 'IT',
        name: `${guestData.name} ${guestData.surname}`,
        phone: guestData.phone,
        email: guestData.email
    };

    // --- FINE MODIFICHE RICHIESTE ---

    const batch = db.batch();
    const orderRef = db.collection('orders').doc(); // Auto-generate ID
    const orderFirebaseId = orderRef.id;
    const orderNumber = `G-${new Date().getTime().toString().slice(-8)}`; // G per Guest

    const mainOrderDetails = {
        id: orderFirebaseId,
        orderNumber: orderNumber,
        orderType: orderType, // Usiamo il tipo d'ordine determinato
        paymentMethod: paymentMethod,
        status: (paymentMethod === 'card' || paymentMethod.startsWith('onDelivery')) ? 'In Attesa di Preparazione' : 'In elaborazione',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        itemCount: itemsToOrder.length,
        subTotal: subtotal,
        shippingFee: shippingCost,
        serviceFee: serviceFee,
        totalPrice: totalPrice,
        orderNotes: '', // Nessuna nota per ora
        shippingAddress: shippingAddress, // Oggetto strutturato
        items: itemsToOrder, // Usiamo gli articoli già validati e arricchiti dal temp cart
        vendorId: vendorId, // Questo è l'ID del singolo venditore per guest checkout
        vendorStoreName: currentVendorFullData.store_name,
        vendorIdsInvolved: vendorIdsInvolved, // Array strutturato
        paymentIntentId: paymentIntentId,
        deliveryMethod: 'delivery', // Per ora, gli ospiti fanno solo consegna a domicilio
        ordineVisibile: true,
        customerId: null, // Nessun ID utente per l'ospite
        customerName: shippingAddress.name, // Prendi il nome dall'indirizzo
        customerEmail: shippingAddress.email,
        customerPhone: shippingAddress.phone,
    };

    batch.set(orderRef, mainOrderDetails);

    // Crea anche il sotto-ordine per il negoziante con la stessa struttura
    const vendorSubOrderRef = db.collection('vendor_orders').doc(vendorId).collection('orders').doc(orderFirebaseId);
    batch.set(vendorSubOrderRef, {
        originalOrderId: orderFirebaseId,
        orderNumber: mainOrderDetails.orderNumber,
        customerId: null, // Ospite non ha ID
        customerName: mainOrderDetails.customerName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        priority: orderPriority, // Imposta la priorità corretta
        status: mainOrderDetails.status,
        items: mainOrderDetails.items, // Usiamo gli articoli già validati e arricchiti
        shippingAddress: shippingAddress, // Oggetto strutturato
        vendorAddress: currentVendorFullData.pickupAddress || null, // Indirizzo del negozio
        vendorLocation: currentVendorFullData.location || null, // Posizione del negozio
        subTotal: mainOrderDetails.subTotal,
        pickupCategory: currentVendorFullData.userType,
        orderType: orderType, // Imposta il tipo d'ordine corretto
        deliveryMethod: 'delivery',
    });

    // Elimina il carrello temporaneo dopo la creazione dell'ordine
    batch.delete(cartDocRef); // Usa il batch per eliminare il documento
    console.log(`✅ Ordine ospite ${orderFirebaseId} creato e carrello temporaneo ${tempGuestCartRef} eliminato.`);

    // Aggiorna il contatore spedizioni gratuite se applicabile (solo daily_limit)
    if (isShippingFree && currentVendorFullData.free_shipping_type === 'daily_limit') {
        const vendorRef = db.collection('vendors').doc(vendorId);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const lastResetDate = currentVendorFullData.data_ultimo_reset_contatore ? currentVendorFullData.data_ultimo_reset_contatore : null;
        let currentCount = currentVendorFullData.contatore_spedizioni_gratuite || 0;

        if (!lastResetDate || !isSameDay(lastResetDate, today)) {
            currentCount = 0;
        }
        currentCount++;

        batch.update(vendorRef, {
            contatore_spedizioni_gratuite: currentCount,
            data_ultimo_reset_contatore: admin.firestore.Timestamp.fromDate(today)
        });
        console.log(`DEBUG: Contatore spedizioni gratuite aggiornato per ${currentVendorFullData.store_name}: ${currentCount}`);
    }

    await batch.commit(); // Commit di tutte le operazioni del batch

    // INVIO EMAIL al negoziante (using the dedicated Vercel Postino function)
    try {
        // VERCEL_URLS non è direttamente disponibile qui, quindi uso la variabile d'ambiente
        const ORDER_EMAIL_NOTIFICATION_URL = process.env.ORDER_EMAIL_NOTIFICATION_URL || 'https://nodejs-serverless-function-express-phi-silk.vercel.app/api/trigger-order-email-notification';

        await fetch(ORDER_EMAIL_NOTIFICATION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                orderId: orderFirebaseId,
                vendorIds: vendorIdsInvolved, // Passa tutti i vendor coinvolti (uno per guest)
                customerName: mainOrderDetails.customerName,
                customerEmail: mainOrderDetails.customerEmail,
                customerPhone: mainOrderDetails.customerPhone,
                shippingAddress: mainOrderDetails.shippingAddress,
                items: mainOrderDetails.items,
                paymentMethod: mainOrderDetails.paymentMethod,
                totalPrice: mainOrderDetails.totalPrice,
                deliveryMethod: mainOrderDetails.deliveryMethod,
            })
        });
        console.log("✉️ Notifiche email al negoziante (guest order) inviate.");
    } catch (e) {
        console.error("❌ Errore nell'invio delle notifiche email al negoziante (guest order):", e);
        // Non rilanciare l'errore, l'ordine è già stato finalizzato nel database.
        // Un errore nell'email non deve bloccare il checkout.
    }

    return res.status(200).json({ orderId: orderFirebaseId, orderNumber });
}
