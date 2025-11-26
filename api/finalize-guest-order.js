// api/finalize-guest-order.js
import Stripe from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GeoPoint, Timestamp } from 'firebase-admin/firestore'; // Importa GeoPoint e Timestamp

// Inizializza Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
});

// Inizializza Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}
const db = getFirestore();

// === MODELLI (Ripetuti qui per auto-contenimento dell'API) ===
class ShippingAddress {
    constructor({ street, city, province, zip, country, floor, deliveryNotes, hasDog, noBell, latitude, longitude }) {
        this.street = street;
        this.city = city;
        this.province = province;
        this.zip = zip;
        this.country = country;
        this.floor = floor;
        this.deliveryNotes = deliveryNotes;
        this.hasDog = hasDog;
        this.noBell = noBell;
        this.latitude = latitude;
        this.longitude = longitude;
    }

    toFirestore() {
        const map = {};
        if (this.street !== undefined) map.street = this.street;
        if (this.city !== undefined) map.city = this.city;
        if (this.province !== undefined) map.province = this.province;
        if (this.zip !== undefined) map.zip = this.zip;
        if (this.country !== undefined) map.country = this.country;
        if (this.floor !== undefined) map.floor = this.floor;
        if (this.deliveryNotes !== undefined) map.deliveryNotes = this.deliveryNotes;
        if (this.hasDog !== undefined) map.hasDog = this.hasDog;
        if (this.noBell !== undefined) map.noBell = this.noBell;
        if (this.latitude !== undefined) map.latitude = this.latitude;
        if (this.longitude !== undefined) map.longitude = this.longitude;
        return map;
    }
}

class OrderItem {
    constructor({ productId, productName, price, quantity, vendorId, vendorStoreName, imageUrl, unit, tipAmount = null, itemType = 'product', bookingDetails, vendorData, options, brand }) {
        this.productId = productId;
        this.productName = productName;
        this.price = price;
        this.quantity = quantity;
        this.vendorId = vendorId;
        this.vendorStoreName = vendorStoreName;
        this.imageUrl = imageUrl;
        this.unit = unit;
        this.tipAmount = tipAmount;
        this.itemType = itemType;
        this.bookingDetails = bookingDetails;
        this.vendorData = vendorData;
        this.options = options;
        this.brand = brand;
    }

    toFirestore() {
        const map = {};
        if (this.productId !== undefined) map.productId = this.productId;
        if (this.productName !== undefined) map.productName = this.productName;
        if (this.price !== undefined) map.price = this.price;
        if (this.quantity !== undefined) map.quantity = this.quantity;
        if (this.vendorId !== undefined) map.vendorId = this.vendorId;
        if (this.vendorStoreName !== undefined) map.vendorStoreName = this.vendorStoreName;
        if (this.imageUrl !== undefined) map.imageUrl = this.imageUrl;
        if (this.unit !== undefined) map.unit = this.unit;
        if (this.tipAmount !== undefined) map.tipAmount = this.tipAmount;
        if (this.itemType !== undefined) map.itemType = this.itemType;
        if (this.bookingDetails !== undefined) map.bookingDetails = this.bookingDetails;
        if (this.vendorData !== undefined) map.vendorData = this.vendorData;
        if (this.options !== undefined) map.options = this.options;
        if (this.brand !== undefined) map.brand = this.brand;
        return map;
    }
}

class MarketplaceSubOrderModel {
    constructor({ originalOrderId, orderNumber, customerId, customerName, createdAt, priority, status, items, shippingAddress, vendorAddress, vendorLocation, subTotal, pickupCategory, orderType }) {
        this.originalOrderId = originalOrderId;
        this.orderNumber = orderNumber;
        this.customerId = customerId;
        this.customerName = customerName;
        this.createdAt = createdAt;
        this.priority = priority;
        this.status = status;
        this.items = items;
        this.shippingAddress = shippingAddress;
        this.vendorAddress = vendorAddress;
        this.vendorLocation = vendorLocation;
        this.subTotal = subTotal;
        this.pickupCategory = pickupCategory;
        this.orderType = orderType;
    }

    toMap() {
        const map = {
            originalOrderId: this.originalOrderId,
            orderNumber: this.orderNumber,
            customerId: this.customerId,
            customerName: this.customerName,
            createdAt: this.createdAt,
            priority: this.priority,
            status: this.status,
            items: this.items.map(item => item.toFirestore()),
            shippingAddress: this.shippingAddress.toFirestore(),
            vendorAddress: this.vendorAddress,
            vendorLocation: (this.vendorLocation instanceof GeoPoint)
                             ? this.vendorLocation
                             : new GeoPoint(this.vendorLocation?.latitude || 0, this.vendorLocation?.longitude || 0),
            subTotal: this.subTotal,
            pickupCategory: this.pickupCategory,
            orderType: this.orderType,
        };
        return map;
    }
}

class OrderModel {
    constructor({ id, customerId, customerName, customerEmail, customerPhone, createdAt, updatedAt, orderNumber, orderType, paymentMethod, itemCount, subTotal, shippingFee, serviceFee, totalPrice, status, orderNotes, shippingAddress, items, vendorId, vendorStoreName, vendorIdsInvolved, pickupCategory, tipAmount = null, ordineVisibile = true, cryptoPaymentDetails, paymentIntentId }) {
        this.id = id;
        this.customerId = customerId;
        this.customerName = customerName;
        this.customerEmail = customerEmail;
        this.customerPhone = customerPhone;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
        this.orderNumber = orderNumber;
        this.orderType = orderType;
        this.paymentMethod = paymentMethod;
        this.itemCount = itemCount;
        this.subTotal = subTotal;
        this.shippingFee = shippingFee;
        this.serviceFee = serviceFee;
        this.totalPrice = totalPrice;
        this.status = status;
        this.orderNotes = orderNotes;
        this.shippingAddress = shippingAddress;
        this.items = items;
        this.vendorId = vendorId;
        this.vendorStoreName = vendorStoreName;
        this.vendorIdsInvolved = vendorIdsInvolved;
        this.pickupCategory = pickupCategory;
        this.tipAmount = tipAmount;
        this.ordineVisibile = ordineVisibile;
        this.cryptoPaymentDetails = cryptoPaymentDetails;
        this.paymentIntentId = paymentIntentId;
    }

    toFirestore() {
        const map = {
            customerId: this.customerId,
            customerName: this.customerName,
            customerEmail: this.customerEmail,
            customerPhone: this.customerPhone,
            createdAt: this.createdAt,
            updatedAt: Timestamp.now(), // Usa Timestamp per il server
            orderNumber: this.orderNumber,
            orderType: this.orderType,
            paymentMethod: this.paymentMethod,
            itemCount: this.itemCount,
            subTotal: this.subTotal,
            shippingFee: this.shippingFee,
            serviceFee: this.serviceFee,
            totalPrice: this.totalPrice,
            status: this.status,
            shippingAddress: this.shippingAddress.toFirestore(),
            items: this.items.map(i => i.toFirestore()),
            vendorIdsInvolved: this.vendorIdsInvolved,
            ordineVisibile: this.ordineVisibile,
        };
        if (this.orderNotes) map.orderNotes = this.orderNotes;
        if (this.vendorId) map.vendorId = this.vendorId;
        if (this.vendorStoreName) map.vendorStoreName = this.vendorStoreName;
        if (this.pickupCategory) map.pickupCategory = this.pickupCategory;
        if (this.cryptoPaymentDetails) map.cryptoPaymentDetails = this.cryptoPaymentDetails;
        if (this.tipAmount !== undefined) map.tipAmount = this.tipAmount;
        if (this.paymentIntentId) map.paymentIntentId = this.paymentIntentId;
        return map;
    }
}

// === FINE MODELLI ===

// Funzione per calcolare il subtotale di articoli per un negoziante specifico
function calculateSubtotalForVendor(items) {
    let sub = items.reduce((sum, item) => sum + (item.price * item.quantity), 0.0);
    return parseFloat(sub.toFixed(2));
}

// Funzione per gestire la richiesta
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Solo richieste POST' });
    }

    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
        return res.status(400).json({ error: 'ID Payment Intent mancante.' });
    }

    try {
        // 1. Recupera il Payment Intent da Stripe
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        // 2. Controlla lo stato del Payment Intent
        if (paymentIntent.status !== 'succeeded') {
            console.error(`Payment Intent ${paymentIntentId} non riuscito. Stato: ${paymentIntent.status}`);
            return res.status(400).json({ error: `Pagamento non riuscito. Stato: ${paymentIntent.status}` });
        }

        // 3. Estrai i metadati dall'Payment Intent (qui abbiamo i dati del carrello e dell'ospite)
        const metadata = paymentIntent.metadata;
        const isGuestOrder = metadata.isGuestOrder === 'true';

        if (!isGuestOrder) {
            // Questa API è specifica per gli ordini ospiti. Se è un utente loggato, un webhook dovrebbe gestire.
            return res.status(400).json({ error: 'Questa API è per gli ordini degli ospiti. Ordine utente loggato non gestito qui.' });
        }

        // Verifica se l'ordine è già stato creato per questo Payment Intent
        const existingOrderSnap = await db.collection('orders').where('paymentIntentId', '==', paymentIntentId).limit(1).get();
        if (!existingOrderSnap.empty) {
            console.log(`Ordine già esistente per Payment Intent ${paymentIntentId}. ID: ${existingOrderSnap.docs[0].id}`);
            return res.status(200).json({ 
                orderId: existingOrderSnap.docs[0].id, 
                orderNumber: existingOrderSnap.docs[0].data().orderNumber,
                message: 'Ordine già creato e recuperato.'
            });
        }

        const guestName = metadata.guestName;
        const guestSurname = metadata.guestSurname;
        const guestEmail = metadata.guestEmail;
        const guestPhone = metadata.guestPhone;
        const vendorId = metadata.vendorId;
        const vendorStoreName = metadata.vendorStoreName;
        const cartItemsString = metadata.cartItems;
        const shippingAmount = parseFloat(paymentIntent.shipping?.amount_total / 100 || 0); // O dal metadata se lo passi
        const totalAmount = paymentIntent.amount / 100;

        const cartItems = JSON.parse(cartItemsString); // Gli items serializzati

        // Ricostruisci l'indirizzo di spedizione (senza GeoPoint qui, a meno che non si faccia geocoding)
        const shippingAddress = new ShippingAddress({
            street: metadata.guestAddress,
            city: metadata.guestCity,
            province: metadata.guestProvince,
            zip: metadata.guestCap,
            country: metadata.guestCountry,
            phone: guestPhone,
            // Aggiungi altri campi se presenti nei metadati
        });

        // 4. Inizia la creazione dell'ordine in Firebase
        const batch = db.batch();
        const mainOrderId = db.collection('orders').doc().id; // Genera un ID per l'ordine principale
        const orderNumber = `G-${new Date().getTime().toString().slice(-8)}`; // Numero ordine Ospite

        const vendorIdsInvolved = [...new Set(cartItems.map(item => item.vendorId))];
        const allSubOrdersForMainOrder = [];

        // Fetch dei dati dei venditori per i sotto-ordini
        const fetchedVendorsData = {};
        if (vendorIdsInvolved.length > 0) {
            const vendorDocs = await Promise.all(vendorIdsInvolved.map(id => db.collection('vendors').doc(id).get()));
            vendorDocs.forEach(docSnap => {
                if (docSnap.exists) {
                    const data = docSnap.data();
                    fetchedVendorsData[docSnap.id] = {
                        store_name: data.store_name,
                        userType: data.userType,
                        pickupAddress: data.pickupAddress || data.address,
                        location: data.location ? new GeoPoint(data.location.latitude, data.location.longitude) : null,
                    };
                }
            });
        }

        // Calcola serviceFee e shippingFee (qui dovresti replicare la logica di calcolo del frontend)
        // Per ora, useremo una stima o cercheremo di estrarli dal PaymentIntent.
        // PaymentIntent.application_fee_amount è la commissione di Stripe Connect.
        const serviceFee = paymentIntent.application_fee_amount ? (paymentIntent.application_fee_amount / 100) : 0;
        let calculatedSubtotal = 0;
        cartItems.forEach(item => calculatedSubtotal += item.price * item.quantity);
        const calculatedShippingFee = totalAmount - calculatedSubtotal - serviceFee; // Stima

        const initialOrderStatus = 'In Attesa di Preparazione'; // Stato iniziale per tutti i nuovi ordini

        for (const vId of vendorIdsInvolved) {
            const vendorSpecificItems = cartItems.filter(item => item.vendorId === vId);
            const vendorData = fetchedVendorsData[vId];
            if (!vendorData) {
                console.warn(`Dati venditore ${vId} non trovati per sotto-ordine.`);
                continue;
            }

            const vendorSubTotal = calculateSubtotalForVendor(vendorSpecificItems);
            const subOrderPriority = (vendorIdsInvolved.length === 1) ? 'EXPRESS' : 'CONSOLIDATO';
            const subOrderType = (vendorIdsInvolved.length === 1) ? 'singleVendorExpress' : 'marketplaceConsolidated';

            const subOrder = new MarketplaceSubOrderModel({
                originalOrderId: mainOrderId,
                orderNumber: orderNumber,
                customerId: `GUEST-${guestEmail}`, // ID per ospite, basato su email
                customerName: `${guestName} ${guestSurname}`,
                createdAt: Timestamp.now(),
                priority: subOrderPriority,
                status: initialOrderStatus,
                items: vendorSpecificItems.map(item => new OrderItem(item)),
                shippingAddress: shippingAddress,
                vendorAddress: vendorData.pickupAddress || null,
                vendorLocation: vendorData.location || null,
                subTotal: vendorSubTotal,
                pickupCategory: vendorData.userType,
                orderType: subOrderType,
            });

            allSubOrdersForMainOrder.push(subOrder);
            const vendorOrderRef = db.collection('vendor_orders').doc(vId).collection('orders').doc(mainOrderId);
            batch.set(vendorOrderRef, subOrder.toMap());

            const mainOrderSubOrderRef = db.collection('orders').doc(mainOrderId).collection('sub_orders').doc(vId);
            batch.set(mainOrderSubOrderRef, subOrder.toMap());
        }

        // Crea l'ordine principale
        const mainOrder = new OrderModel({
            id: mainOrderId,
            customerId: `GUEST-${guestEmail}`, // ID per ospite
            customerName: `${guestName} ${guestSurname}`,
            customerEmail: guestEmail,
            customerPhone: guestPhone,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
            orderNumber: orderNumber,
            orderType: (vendorIdsInvolved.length === 1) ? 'singleVendorExpress' : 'marketplaceConsolidated',
            paymentMethod: 'card', // Pagato con carta
            itemCount: cartItems.reduce((sum, item) => sum + item.quantity, 0),
            subTotal: calculatedSubtotal,
            shippingFee: calculatedShippingFee,
            serviceFee: serviceFee,
            totalPrice: totalAmount,
            status: initialOrderStatus,
            orderNotes: metadata.orderNotes || '', // Se avevi campi per le note nell'ospite
            shippingAddress: shippingAddress,
            items: cartItems.map(item => new OrderItem(item)),
            vendorId: (vendorIdsInvolved.length === 1) ? vendorIdsInvolved[0] : null,
            vendorStoreName: (vendorIdsInvolved.length === 1) ? vendorStoreName : null,
            vendorIdsInvolved: vendorIdsInvolved,
            paymentIntentId: paymentIntentId,
        });

        const mainOrderRef = db.collection('orders').doc(mainOrderId);
        batch.set(mainOrderRef, mainOrder.toFirestore());

        await batch.commit();

        // 5. Invia notifica email al cliente e ai negozianti
        // Questa parte è molto importante, e dovresti riattivare la tua funzione `VERCEL_TRIGGER_ORDER_EMAIL_NOTIFICATION_URL` se l'avevi disabilitata
        // Potresti anche voler inviare un'email al cliente ospite qui per la conferma.
        // Per ora, faccio un console.log per indicare il punto.
        console.log(`✅ Ordine Ospite ${mainOrderId} creato con successo in Firebase.`);
        // Qui dovresti chiamare la tua API per le notifiche email
        // Esempio:
        // await fetch(VERCEL_URLS.ORDER_EMAIL_NOTIFICATION, {
        //     method: 'POST',
        //     headers: {'Content-Type': 'application/json'},
        //     body: JSON.stringify({ orderId: mainOrderId, ...dati per email... })
        // });


        res.status(200).json({
            orderId: mainOrderId,
            orderNumber: orderNumber,
            message: 'Ordine creato con successo.'
        });

    } catch (error) {
        console.error('Errore durante la finalizzazione dell\'ordine ospite:', error);
        res.status(500).json({ error: error.message || 'Errore interno del server durante la finalizzazione dell\'ordine.' });
    }
};
