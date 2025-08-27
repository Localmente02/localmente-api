// Contenuto del file /api/upload.js - VERSIONE CORRETTA

import { put } from '@vercel/blob';


export default async function POST(request) {
  const { searchParams } = new URL(request.url);
  const filename = searchParams.get('filename');

  if (!filename || !request.body) {
    return new Response(
      JSON.stringify({ message: 'Richiesta non valida.' }),
      { status: 400 }
    );
  }

  try {
    const blob = await put(filename, request.body, {
      access: 'public',
    });

    return new Response(
      JSON.stringify(blob),
      { status: 200 }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ message: 'Errore durante l\'upload su Vercel Blob', error: error.message }),
      { status: 500 }
    );
  }
}
