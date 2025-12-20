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
    const d2 = date2 instanceof Date ? date2 : d2.toDate(); // Converte Timestamp se necessario

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
    const { cartItems, isGuest, guestData, clientClaimedTotal, tempGuestCartRef, vendorId, customerUserId, deliveryMethod, selectedAddress, orderNotes } = req.body; // 🔥 NUOVO: Aggiunto orderNotes

    console.log(`🔒 Bunker avviato. Guest: ${isGuest}, Vendor: ${vendorId}, User: ${customerUserId}`);
    console.log(`DEBUG_BACKEND: Richiesta CALCULATE_AND_PAY - Payload: ${JSON.stringify(req.body)}`);

    const tempCartCollectionName = isGuest ? 'temp_guest_carts' : 'temp_carts';


    // 1. Configurazione Globale (Fee e Spedizioni)
    const settingsDoc = await db.collection('app_settings').doc('main_config').get();
    const settings = settingsDoc.data() || {};
    console.log("DEBUG_BACKEND: _appSettings caricate da Firebase (backend):", settings);
    
    // Tariffe per gli ospiti (fallback se non presenti)
    const GUEST_SHIPPING_FEE = settings.guest_shipping_fee_single_vendor || 3.99;
    const GUEST_SERVICE_FEE_PERCENTAGE = settings.guest_service_fee_percentage_single_vendor || 0.125;

    // Tariffe per utenti registrati (fallback se non presenti)
    const AUTH_SHIPPING_FEE = settings.shipping_fee_single_vendor || 3.99;
    const AUTH_SERVICE_FEE_PERCENTAGE = (typeof settings.service_fee_percentage_single_vendor === 'number')
        ? settings.service_fee_percentage_single_vendor
        : 0.125;


    let serverGoodsTotal = 0;
    let validatedItems = [];
    let primaryVendorId = null;

    // 2. Calcolo Reale dei Prezzi e Validazione Articoli
    for (const item of cartItems) {
        const collectionName = item.type === 'alimentari' ? 'alimentari_products' : 'offers';
        const docRef = db.collection(collectionName).doc(item.docId || item.id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            console.warn(`Articolo non trovato nel DB: ${item.docId || item.id} nella collezione ${collectionName}. Saltato.`);
            continue; 
        }

        const data = docSnap.data();
        const realPrice = parseFloat(data.price);
        const qty = parseInt(item.quantity);

        serverGoodsTotal += realPrice * qty;
        
        if (!primaryVendorId) primaryVendorId = data.vendorId;
        else if (primaryVendorId !== data.vendorId) primaryVendorId = 'MARKETPLACE_MIX';

        validatedItems.push({ 
            ...item, 
            docId: item.docId || item.id,
            productName: data.productName,
            imageUrl: data.primaryImageUrl || data.productImageUrl || '/assets/placeholder_fallback_image.png',
            price: realPrice,
            vendorId: data.vendorId,
            vendorStoreName: data.store_name || 'Sconosciuto',
            options: item.options || {},
            type: item.type
        });
    }
    serverGoodsTotal = parseFloat(serverGoodsTotal.toFixed(2));


    // 3. Calcolo Spedizione (logica dettagliata)
    let serverShipping = isGuest ? GUEST_SHIPPING_FEE : AUTH_SHIPPING_FEE;
    let isShippingFree = false;

    if (deliveryMethod === 'pickup') {
        serverShipping = 0;
        isShippingFree = true;
    } else {
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
    }
    serverShipping = parseFloat(serverShipping.toFixed(2));
    console.log(`DEBUG_BACKEND: Spedizione calcolata: ${serverShipping}, Gratuita: ${isShippingFree}, Metodo: ${deliveryMethod}`);


    // 4. Calcolo Service Fee
    let serviceFeePercentage = isGuest ? GUEST_SERVICE_FEE_PERCENTAGE : AUTH_SERVICE_FEE_PERCENTAGE;
    let serverFee = serverGoodsTotal * serviceFeePercentage;
    serverFee = parseFloat(serverFee.toFixed(2));
    console.log(`DEBUG_BACKEND: Percentuale commissione usata: ${serviceFeePercentage}, Commissione calcolata: ${serverFee}`);

    const serverGrandTotal = parseFloat((serverGoodsTotal + serverShipping + serverFee).toFixed(2));
    console.log(`DEBUG_BACKEND: Totali finali server - Subtotal: ${serverGoodsTotal}, Shipping: ${serverShipping}, Service Fee: ${serverFee}, Total: ${serverGrandTotal}`);


    // 5. Aggiorna il carrello temporaneo con i totali calcolati in modo sicuro
    if (tempGuestCartRef) {
        const tempCartRef = db.collection(tempCartCollectionName).doc(tempGuestCartRef);
        await tempCartRef.update({
            items: validatedItems,
            subtotal: serverGoodsTotal,
            shippingCost: serverShipping,
            serviceFee: serverFee,
            totalPrice: serverGrandTotal,
            isShippingFree: isShippingFree,
            deliveryMethod: deliveryMethod || null, // FIX: Converti undefined a null
            selectedAddress: selectedAddress || null, // FIX: Converti undefined a null
            orderNotes: orderNotes || null, // 🔥 NUOVO: Salva le note dell'ordine
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            customerUserId: customerUserId || null,
        });
        console.log(`✅ Carrello temporaneo ${tempCartCollectionName}/${tempGuestCartRef} aggiornato con totali sicuri.`);
    }


    // 6. WATCHDOG (Sicurezza) - Confronta il totale calcolato dal client con quello del server
    if (clientClaimedTotal !== undefined && clientClaimedTotal > 0) {
        const diff = Math.abs(serverGrandTotal * 100 - clientClaimedTotal);
        if (diff > 100) { // Tolleranza di 1 euro (100 centesimi)
            console.warn(`🚨 HACK ATTEMPT? Client claimed: ${clientClaimedTotal/100} vs Server calculated: ${serverGrandTotal}`);
            await db.collection('_security_audits').add({
                type: 'PRICE_TAMPERING',
                email: (isGuest ? guestData?.email : customerUserId) || 'unknown',
                diff: diff / 100,
                claimedTotal: clientClaimedTotal / 100,
                serverTotal: serverGrandTotal,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                cartItems: cartItems
            });
            throw new Error("Discrepanza nei prezzi rilevata. Aggiorna il carrello e riprova.");
        }
    }


    // 7. Crea Payment Intent di Stripe
    const amountInt = Math.round(serverGrandTotal * 100);
    
    const vendorDataSnap = await db.collection('vendors').doc(vendorId).get();
    if (!vendorDataSnap.exists) {
        throw new Error("Dati del venditore non trovati per Stripe Account ID.");
    }
    const vendorStripeAccountId = vendorDataSnap.data().stripeAccountId;

    if (!vendorStripeAccountId) {
        throw new Error("Stripe Account ID del venditore non configurato.");
    }

    const metadata = {
        isGuestOrder: isGuest ? 'true' : 'false',
        civoraFee: serverFee.toString(),
        shippingCost: serverShipping.toString(),
        subTotal: serverGoodsTotal.toString(),
        totalPrice: serverGrandTotal.toString(),
        vendorId: vendorId,
        tempCartRefId: tempGuestCartRef,
        tempCartCollection: tempCartCollectionName,
    };
    
    if (isGuest && guestData) {
        if(guestData.name) metadata.guestName = guestData.name;
        if(guestData.surname) metadata.guestSurname = guestData.surname;
        if(guestData.phone) metadata.guestPhone = guestData.phone;
        if(guestData.email) metadata.guestEmail = guestData.email;
    } else if (!isGuest && customerUserId) {
        metadata.customerUserId = customerUserId;
    }


    const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInt,
        currency: 'eur',
        automatic_payment_methods: { enabled: true },
        application_fee_amount: Math.round(serverFee * 100),
        transfer_data: {
            destination: vendorStripeAccountId,
        },
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
    const { paymentIntentId, guestData, tempGuestCartRef, vendorId, paymentMethod, customerUserId, customerShippingData, deliveryMethod, orderNotes, isMercatoFresco } = req.body;
    
    console.log(`DEBUG_BACKEND: Richiesta FINALIZE_ORDER - Payload: ${JSON.stringify(req.body)}`);

    if (!paymentIntentId && paymentMethod !== 'FREE_ORDER' && !paymentMethod.startsWith('onDelivery')) throw new Error("PaymentIntentId mancante per pagamento con carta.");
    if (!tempGuestCartRef) throw new Error("Riferimento carrello temporaneo mancante.");
    
    const isGuestOrder = !!guestData;
    const currentUserId = customerUserId || null;

    let tempCartCollectionName = isGuestOrder ? 'temp_guest_carts' : 'temp_carts';
    if (paymentIntentId && paymentIntentId !== 'FREE_ORDER') {
        try {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
            if (pi.metadata?.tempCartCollection) {
                tempCartCollectionName = pi.metadata.tempCartCollection;
                console.log(`DEBUG_BACKEND: Sovrascritto tempCartCollectionName da PI metadata: ${tempCartCollectionName}`);
            }
        } catch (error) {
            console.warn(`AVVISO: Impossibile recuperare metadata per PaymentIntent ${paymentIntentId}. Usando collezione inferita.`);
        }
    }


    if (paymentIntentId !== 'FREE_ORDER') {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status !== 'succeeded') throw new Error(`Pagamento non riuscito: ${pi.status}. Stato attuale: ${pi.status}`);
    }

    const exist = await db.collection('orders').where('paymentIntentId', '==', paymentIntentId).limit(1).get();
    if (!exist.empty) {
        console.warn(`Ordine per PaymentIntentId ${paymentIntentId} già esistente: ${exist.docs[0].id}. Ignoro finalizzazione duplicata.`);
        return res.status(200).json({ orderId: exist.docs[0].id, message: 'Ordine già esistente' });
    }

    const cartDocRef = db.collection(tempCartCollectionName).doc(tempGuestCartRef);
    const cartDoc = await cartDocRef.get();

    if (!cartDoc.exists) {
        console.error(`Temp cart ${tempCartCollectionName}/${tempGuestCartRef} not found during finalization.`);
        throw new Error('Carrello temporaneo non trovato o scaduto per la finalizzazione.');
    }
    const tempCartData = cartDoc.data();
    console.log(`DEBUG_BACKEND: Dati carrello temporaneo (${tempCartCollectionName}/${tempGuestCartRef}) per finalizzazione: ${JSON.stringify(tempCartData)}`);

    const itemsToOrder = tempCartData.items;
    const subtotal = tempCartData.subtotal;
    const shippingCost = tempCartData.shippingCost;
    const serviceFee = tempCartData.serviceFee;
    const totalPrice = tempCartData.totalPrice;
    const isShippingFree = tempCartData.isShippingFree;
    const orderDeliveryMethod = tempCartData.deliveryMethod || deliveryMethod || 'delivery';
    const selectedAddressData = tempCartData.selectedAddress || customerShippingData || {};
    const finalOrderNotes = tempCartData.orderNotes || orderNotes || ''; // 🔥 NUOVO: Precedenza a tempCartData.orderNotes


    if (!itemsToOrder || itemsToOrder.length === 0) {
        console.error("Carrello vuoto o scaduto nel temp_carts durante finalizzazione.");
        throw new Error("Carrello vuoto o scaduto.");
    }

    const vendorIdsFromItems = [...new Set(itemsToOrder.map(item => item.vendorId))];
    const firstVendorId = vendorIdsFromItems[0];
    
    let currentVendorFullData = {};
    const finalVendorIdForData = vendorId || firstVendorId;
    
    if (finalVendorIdForData) {
        const vendorDoc = await db.collection('vendors').doc(finalVendorIdForData).get();
        if (!vendorDoc.exists) {
            console.error(`Vendor ${finalVendorIdForData} not found during order finalization.`);
            throw new Error('Dettagli del negoziante non trovati per la finalizzazione.');
        }
        currentVendorFullData = vendorDoc.data();
    }
    console.log(`DEBUG_BACKEND: Dati venditore principale per finalizzazione: ${JSON.stringify(currentVendorFullData)}`);


    const orderPriority = (vendorIdsFromItems.length === 1 && !isMercatoFresco) ? 'EXPRESS' : 'CONSOLIDATO';
    const orderType = (vendorIdsFromItems.length === 1 && !isMercatoFresco) ? 'singleVendorExpress' : 'marketplaceConsolidated';
    const vendorIdsInvolved = vendorIdsFromItems;

    let shippingAddress = null;
    if (orderDeliveryMethod === 'delivery' && selectedAddressData) {
         shippingAddress = {
            street: selectedAddressData.street,
            city: selectedAddressData.city,
            zipCode: selectedAddressData.cap || selectedAddressData.zipCode,
            province: selectedAddressData.province,
            country: selectedAddressData.country || 'IT', // Assicurati che sia IT o codice ISO 3166-1 alpha-2
            name: selectedAddressData.name,
            phone: selectedAddressData.phone || selectedAddressData.phoneNumber,
            email: selectedAddressData.email,
            houseNumber: selectedAddressData.houseNumber,
            floor: selectedAddressData.floor,
            hasDog: selectedAddressData.hasDog,
            noBell: selectedAddressData.noBell,
            deliveryNotes: finalOrderNotes || selectedAddressData.deliveryNotesForAddress || '', // Note globali o dell'indirizzo
        };
    }
    console.log(`DEBUG_BACKEND: Indirizzo di spedizione strutturato: ${JSON.stringify(shippingAddress)}`);


    const batch = db.batch();
    const orderRef = db.collection('orders').doc();
    const orderFirebaseId = orderRef.id;
    const orderNumberPrefix = isGuestOrder ? 'G-' : 'C-';
    const orderNumber = `${orderNumberPrefix}${new Date().getTime().toString().slice(-8)}`; 

    const mainOrderDetails = {
        id: orderFirebaseId,
        orderNumber: orderNumber,
        orderType: orderType, 
        paymentMethod: paymentMethod,
        status: (paymentMethod === 'card' || paymentMethod.startsWith('onDelivery')) ? 'In Attesa di Preparazione' : 'In elaborazione',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        itemCount: itemsToOrder.length,
        subTotal: subtotal,
        shippingFee: shippingCost,
        serviceFee: serviceFee,
        totalPrice: totalPrice,
        orderNotes: finalOrderNotes, // 🔥 NUOVO: Usa finalOrderNotes
        shippingAddress: shippingAddress, 
        items: itemsToOrder,
        vendorId: (vendorIdsInvolved.length === 1 && !isMercatoFresco) ? vendorIdsInvolved[0] : null, 
        vendorStoreName: (vendorIdsInvolved.length === 1 && !isMercatoFresco) ? currentVendorFullData.store_name : null,
        vendorIdsInvolved: vendorIdsInvolved, 
        pickupCategory: (vendorIdsInvolved.length === 1 && !isMercatoFresco) ? currentVendorFullData.userType : null,
        paymentIntentId: paymentIntentId,
        deliveryMethod: orderDeliveryMethod, 
        ordineVisibile: true,
        customerId: currentUserId,
        customerName: selectedAddressData?.name || guestData?.name || 'Cliente Sconosciuto',
        customerEmail: selectedAddressData?.email || guestData?.email || 'email@sconosciuta.com',
        customerPhone: selectedAddressData?.phone || selectedAddressData?.phoneNumber || guestData?.phone || 'N/D',
    };
    console.log(`DEBUG_BACKEND: Dettagli ordine principale: ${JSON.stringify(mainOrderDetails)}`);

    batch.set(orderRef, mainOrderDetails);

    for (const vid of vendorIdsInvolved) {
        const vendorSpecificItems = itemsToOrder.filter(item => item.vendorId === vid);
        const subTotalForVendor = vendorSpecificItems.reduce((sum, item) => sum + (item.price * item.quantity), 0.0);
        
        let subOrderVendorData = currentVendorFullData;
        if (vid !== finalVendorIdForData && vendorIdsFromItems.length > 1) {
             const subVendorDoc = await db.collection('vendors').doc(vid).get();
             if (subVendorDoc.exists()) {
                 subOrderVendorData = subVendorDoc.data();
             } else {
                 console.warn(`Dati venditore ${vid} non trovati per il sotto-ordine.`);
             }
        }


        const vendorSubOrderRef = db.collection('vendor_orders').doc(vid).collection('orders').doc(orderFirebaseId);
        batch.set(vendorSubOrderRef, {
            originalOrderId: orderFirebaseId,
            orderNumber: mainOrderDetails.orderNumber,
            customerId: mainOrderDetails.customerId, 
            customerName: mainOrderDetails.customerName,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            priority: orderPriority, 
            status: mainOrderDetails.status,
            items: vendorSpecificItems, 
            shippingAddress: shippingAddress, 
            vendorAddress: subOrderVendorData.pickupAddress || null,
            vendorLocation: subOrderVendorData.location || null,
            subTotal: parseFloat(subTotalForVendor.toFixed(2)), 
            pickupCategory: subOrderVendorData.userType,
            orderType: orderType, 
            deliveryMethod: orderDeliveryMethod,
            totalPrice: (vendorIdsInvolved.length === 1 && !isMercatoFresco)
                        ? parseFloat(subTotalForVendor + shippingCost + serviceFee).toFixed(2)
                        : parseFloat(subTotalForVendor).toFixed(2),
        });
        console.log(`DEBUG_BACKEND: Dettagli sotto-ordine per venditore ${vid}: ${JSON.stringify(vendorSubOrderRef)}`);
    }

    batch.delete(cartDocRef); 
    console.log(`✅ Ordine ${orderFirebaseId} creato e carrello temporaneo ${tempCartCollectionName}/${tempGuestCartRef} eliminato.`);

    if (orderDeliveryMethod === 'delivery' && isShippingFree && vendorIdsInvolved.length === 1) {
        const vendorRef = db.collection('vendors').doc(finalVendorIdForData);
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

    await batch.commit();

    try {
        const ORDER_EMAIL_NOTIFICATION_URL = process.env.ORDER_EMAIL_NOTIFICATION_URL || 'https://nodejs-serverless-function-express-phi-silk.vercel.app/api/trigger-order-email-notification';

        await fetch(ORDER_EMAIL_NOTIFICATION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                orderId: orderFirebaseId,
                vendorIds: vendorIdsInvolved, 
                customerName: mainOrderDetails.customerName,
                customerEmail: mainOrderDetails.customerEmail,
                customerPhone: mainOrderDetails.customerPhone,
                shippingAddress: mainOrderDetails.shippingAddress,
                items: mainOrderDetails.items.map(item => item.toFirestore()),
                paymentMethod: mainOrderDetails.paymentMethod,
                totalPrice: mainOrderDetails.totalPrice,
                deliveryMethod: mainOrderDetails.deliveryMethod,
            })
        });
        console.log("✉️ Notifiche email al negoziante inviate.");
    } catch (e) {
        console.error("❌ Errore nell'invio delle notifiche email al negoziante:", e);
    }

    return res.status(200).json({ orderId: orderFirebaseId, orderNumber });
}
