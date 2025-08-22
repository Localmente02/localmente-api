// File: api/get-available-slots.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error('ERRORE DEFINITIVO: Inizializzazione Firebase fallita.', error);
  }
}

const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', 'https://localmente-v3-core.web.app');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito. Utilizzare POST.' });
  }

  try {
    const { bookingType, vendorId } = req.body;

    // ==========================================================
    // === NUOVO "SMISTATORE": CAPIAMO COSA FARE ===
    // ==========================================================
    if (bookingType === 'rental') {
      // --- LOGICA PER IL NOLEGGIO VEICOLI ---
      const { vehicleId, startDate, endDate } = req.body;
      if (!vendorId || !vehicleId || !startDate || !endDate) {
        return res.status(400).json({ error: 'Dati mancanti per la verifica del noleggio.' });
      }
      
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      const bookingsSnapshot = await db.collection('bookings')
        .where('vendorId', '==', vendorId)
        .where('serviceId', '==', vehicleId)
        .where('type', '==', 'noleggio')
        .where('status', '==', 'confirmed')
        .get();

      let isAvailable = true;
      for (const doc of bookingsSnapshot.docs) {
        const booking = doc.data();
        const bookingStart = booking.startDateTime.toDate();
        const bookingEnd = booking.endDateTime.toDate();
        if (start < bookingEnd && end > bookingStart) {
          isAvailable = false;
          break;
        }
      }
      return res.status(200).json({ available: isAvailable });
      
    } else {
      // --- LOGICA ESISTENTE PER I SERVIZI (INTATTA) ---
      const { serviceId, date } = req.body;
      if (!vendorId || !serviceId || !date) {
        return res.status(400).json({ error: 'Dati mancanti per la verifica del servizio.' });
      }

      const [serviceDoc, vendorDoc, resourcesSnapshot, bookingsSnapshot] = await Promise.all([
          db.collection('offers').doc(serviceId).get(),
          db.collection('vendors').doc(vendorId).get(),
          db.collection('vendors').doc(vendorId).collection('resources').get(),
          db.collection('bookings')
            .where('vendorId', '==', vendorId)
            // CORREZIONE: usiamo startDateTime come nel tuo codice originale
            .where('startDateTime', '>=', new Date(date + 'T00:00:00Z'))
            .where('startDateTime', '<=', new Date(date + 'T23:59:59Z'))
            .get()
      ]);

      if (!serviceDoc.exists || !serviceDoc.data().serviceDuration) { return res.status(404).json({ error: 'Servizio non trovato o senza durata.' }); }
      const serviceData = serviceDoc.data();
      const serviceDuration = serviceData.serviceDuration;
      const requirements = serviceData.requirements || [];

      if (!vendorDoc.exists || !vendorDoc.data().opening_hours_structured) { return res.status(200).json({ slots: [], message: 'Orari non configurati.' }); }
      const dateObj = new Date(date + 'T00:00:00Z');
      const dayOfWeek = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"][dateObj.getUTCDay()];
      const todayHours = vendorDoc.data().opening_hours_structured.find(d => d.day === dayOfWeek);
      if (!todayHours || !todayHours.isOpen) { return res.status(200).json({ slots: [], message: 'Negozio chiuso.' }); }

      const allResources = resourcesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const existingBookings = bookingsSnapshot.docs.map(doc => ({
        // CORREZIONE: usiamo startDateTime e endDateTime come nel tuo codice originale
        start: doc.data().startDateTime.toDate(),
        end: doc.data().endDateTime.toDate(),
        assignedResourceIds: doc.data().assignedResourceIds || []
      }));

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
                      const availableResourcesInGroup = resourcesInGroup.filter(resource => {
                          const isBusy = existingBookings.some(booking => 
                              booking.assignedResourceIds.includes(resource.id) &&
                              (currentTime < booking.end && potentialEndTime > booking.start)
                          );
                          return !isBusy;
                      });
                      if (availableResourcesInGroup.length < req.quantity) {
                          areAllRequirementsMet = false;
                          break; 
                      }
                  }
              } else {
                  const isTimeSlotBusy = existingBookings.some(booking =>
                      currentTime < booking.end && potentialEndTime > booking.start
                  );
                  if (isTimeSlotBusy) {
                      areAllRequirementsMet = false;
                  }
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
    res.status(500).json({ error: 'Errore interno del server.', details: error.message });
  }
};
