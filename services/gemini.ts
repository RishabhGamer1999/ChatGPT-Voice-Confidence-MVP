import { GoogleGenAI } from "@google/genai";

export const getAIInstance = () => {
  const apiKey = (process.env as any).API_KEY;
  if (!apiKey) {
    console.error("API_KEY environment variable is not set.");
  }
  return new GoogleGenAI({ apiKey: apiKey || "" });
};

export async function getHinglishResponse(userInput: string) {
  const ai = getAIInstance();
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: userInput,
      config: {
        systemInstruction: `You are a helpful AI assistant that understands Hinglish. 
        Respond in a natural Hinglish tone. 
        Keep responses concise for a voice interface.`,
        temperature: 0.7,
      },
    });
    return response.text || "No response received.";
  } catch (error) {
    console.error("Gemini Error:", error);
    return "Maafi chahta hoon, kuch error aa gaya.";
  }
}

export function encodeAudio(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeAudio(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}