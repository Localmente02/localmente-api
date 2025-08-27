import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';

export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const filename = searchParams.get('filename');

  if (!filename) {
    return NextResponse.json({ message: 'Nome del file non trovato.' }, { status: 400 });
  }

  // Controlla che il corpo della richiesta esista
  if (!request.body) {
    return NextResponse.json({ message: 'Corpo della richiesta mancante.' }, { status: 400 });
  }

  try {
    // Carica il corpo della richiesta (l'immagine) direttamente su Vercel Blob
    const blob = await put(filename, request.body, {
      access: 'public',
    });

    // Usa NextResponse per creare una risposta JSON con le intestazioni CORS corrette
    const response = NextResponse.json(blob, { status: 200 });
    
    // Aggiungiamo esplicitamente le intestazioni CORS per massima compatibilità
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE, PUT');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    return response;

  } catch (error) {
    const errorResponse = NextResponse.json(
        { message: 'Errore durante l\'upload su Vercel Blob', error: error.message },
        { status: 500 }
    );
    // Aggiungiamo le intestazioni CORS anche in caso di errore
    errorResponse.headers.set('Access-Control-Allow-Origin', '*');
    return errorResponse;
  }
}

// Aggiungiamo una funzione per gestire le richieste OPTIONS (necessarie per CORS)
export async function OPTIONS() {
    const response = new Response(null, { status: 204 });
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE, PUT');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return response;
}
