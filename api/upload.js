import { put } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // Gestione CORS per la richiesta OPTIONS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  // Imposta CORS per la richiesta POST
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Metodo non consentito.' });
  }

  const filename = req.query.filename;
  if (!filename) {
    return res.status(400).json({ message: 'Nome del file non trovato.' });
  }
  
  try {
    // Passiamo la richiesta 'req' direttamente. È il flusso dell'immagine.
    const blob = await put(filename, req, {
      access: 'public',
    });

    return res.status(200).json(blob);
    
  } catch (error) {
    console.error('ERRORE VERO SU VERCEL:', error); // Logghiamo l'errore vero
    return res.status(500).json({ message: error.message });
  }
}
