// api/finalize-guest-order.js
// Usa require syntax per consistenza con user's create-payment-intent.js
const Stripe = require('stripe');
const admin = require('firebase-admin');
const { GeoPoint, Timestamp } = admin.firestore; // Correct way to get GeoPoint and Timestamp for admin SDK

// Inizializza Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16',
});

// Inizializza Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!admin.apps.length) {
    admin.initializeApp({
        credential: cert(serviceAccount)
    });
}
const db = admin.firestore();

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
    // Set CORS headers for all requests (OPTIONS and POST)
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS'); // OPTIONS method is crucial
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version');
    res.setHeader('Access-Control-Max-Age', '86400');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Only POST requests are allowed for this endpoint.' });
    }

    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
        return res.status(400).json({ error: 'Missing Payment Intent ID in request body.' });
    }

    try {
        // 1. Retrieve the Payment Intent from Stripe
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        // 2. Check the status of the Payment Intent
        if (paymentIntent.status !== 'succeeded') {
            console.error(`Payment Intent ${paymentIntentId} not succeeded. Status: ${paymentIntent.status}`);
            return res.status(400).json({ error: `Payment not succeeded. Status: ${paymentIntent.status}` });
        }

        // 3. Extract metadata from the Payment Intent
        const metadata = paymentIntent.metadata;
        const isGuestOrder = metadata.isGuestOrder === 'true';

        if (!isGuestOrder) {
            return res.status(400).json({ error: 'This API is for guest orders. Logged-in user orders are not handled here.' });
        }

        // Check if the order has already been created for this Payment Intent to prevent duplicates
        const existingOrderSnap = await db.collection('orders').where('paymentIntentId', '==', paymentIntentId).limit(1).get();
        if (!existingOrderSnap.empty) {
            console.log(`Order already exists for Payment Intent ${paymentIntentId}. Order ID: ${existingOrderSnap.docs[0].id}`);
            return res.status(200).json({ 
                orderId: existingOrderSnap.docs[0].id, 
                orderNumber: existingOrderSnap.docs[0].data().orderNumber,
                message: 'Order already created and retrieved.'
            });
        }

        const guestName = metadata.guestName;
        const guestSurname = metadata.guestSurname;
        const guestEmail = metadata.guestEmail;
        const guestPhone = metadata.guestPhone;
        const vendorStoreName = metadata.vendorStoreName;
        const cartItemsString = metadata.cartItems;
        
        let cartItems;
        try {
            cartItems = JSON.parse(cartItemsString);
            if (!Array.isArray(cartItems) || cartItems.length === 0) {
                throw new Error("Cart items from metadata are invalid or empty.");
            }
        } catch (parseError) {
            console.error("Error parsing cartItems from metadata:", parseError);
            return res.status(400).json({ error: 'Invalid cart data in metadata.' });
        }

        // Reconstruct the shipping address
        const shippingAddress = new ShippingAddress({
            street: metadata.guestAddress,
            city: metadata.guestCity,
            province: metadata.guestProvince,
            zip: metadata.guestCap,
            country: metadata.guestCountry,
            phoneNumber: guestPhone, 
            floor: metadata.guestFloor || null,
            deliveryNotes: metadata.guestDeliveryNotes || null,
            hasDog: metadata.guestHasDog === 'true',
            noBell: metadata.guestNoBell === 'true',
        });

        // 4. Start creating the order in Firebase
        const batch = db.batch();
        const mainOrderId = db.collection('orders').doc().id; 
        const orderNumber = `G-${new Date().getTime().toString().slice(-8)}`; 

        // Filter out any invalid/empty vendorIds BEFORE processing
        const vendorIdsInvolved = [...new Set(cartItems.map(item => item.vendorId).filter(vId => vId && typeof vId === 'string' && vId.trim() !== ''))];
        if (vendorIdsInvolved.length === 0) {
            return res.status(400).json({ error: 'No valid vendor IDs found in cart items for order creation.' });
        }

        const allSubOrdersForMainOrder = [];

        // Fetch vendor data for sub-orders
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

        // Calculate fees
        const serviceFee = paymentIntent.application_fee_amount ? (paymentIntent.application_fee_amount / 100) : 0;
        let calculatedSubtotal = 0;
        cartItems.forEach(item => calculatedSubtotal += item.price * item.quantity);
        const totalAmount = paymentIntent.amount / 100;
        const calculatedShippingFee = totalAmount - calculatedSubtotal - serviceFee; 

        const initialOrderStatus = 'In Attesa di Preparazione'; // Initial status for new orders

        for (const vId of vendorIdsInvolved) {
            const vendorSpecificItems = cartItems.filter(item => item.vendorId === vId);
            const vendorData = fetchedVendorsData[vId];
            if (!vendorData) {
                console.warn(`Vendor data for ${vId} not found for sub-order. Skipping sub-order creation for this vendor.`);
                continue;
            }

            const vendorSubTotal = calculateSubtotalForVendor(vendorSpecificItems);
            const subOrderPriority = (vendorIdsInvolved.length === 1) ? 'EXPRESS' : 'CONSOLIDATO';
            const subOrderType = (vendorIdsInvolved.length === 1) ? 'singleVendorExpress' : 'marketplaceConsolidated';

            const subOrder = new MarketplaceSubOrderModel({
                originalOrderId: mainOrderId,
                orderNumber: orderNumber,
                customerId: `GUEST-${guestEmail}`, 
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

        // Create the main order
        const mainOrder = new OrderModel({
            id: mainOrderId,
            customerId: `GUEST-${guestEmail}`, 
            customerName: `${guestName} ${guestSurname}`,
            customerEmail: guestEmail,
            customerPhone: guestPhone,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
            orderNumber: orderNumber,
            orderType: (vendorIdsInvolved.length === 1) ? 'singleVendorExpress' : 'marketplaceConsolidated',
            paymentMethod: 'card', 
            itemCount: cartItems.reduce((sum, item) => sum + item.quantity, 0),
            subTotal: calculatedSubtotal,
            shippingFee: calculatedShippingFee,
            serviceFee: serviceFee,
            totalPrice: totalAmount,
            status: initialOrderStatus,
            orderNotes: metadata.orderNotes || '', 
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

        console.log(`✅ Guest Order ${mainOrderId} created successfully in Firebase.`);
        // Qui potresti chiamare la tua API per le notifiche email. Esempio:
        // await fetch(VERCEL_URLS.ORDER_EMAIL_NOTIFICATION, {
        //     method: 'POST',
        //     headers: {'Content-Type': 'application/json'},
        //     body: JSON.stringify({
        //         orderId: mainOrderId,
        //         vendorIds: vendorIdsInvolved,
        //         customerName: mainOrder.customerName,
        //         customerEmail: mainOrder.customerEmail,
        //         customerPhone: mainOrder.customerPhone,
        //         shippingAddress: mainOrder.shippingAddress.toFirestore(),
        //         items: mainOrder.items.map(item => item.toFirestore()),
        //         totalPrice: mainOrder.totalPrice,
        //         isGuestOrder: true,
        //         // Add any other necessary details for emails
        //     })
        // });


        res.status(200).json({
            orderId: mainOrderId,
            orderNumber: orderNumber,
            message: 'Order created successfully.'
        });

    } catch (error) {
        console.error('Error during guest order finalization:', error);
        res.status(500).json({ error: error.message || 'Internal server error during order finalization.' });
    }
};
