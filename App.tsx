import React, { useState, useEffect, useRef } from 'react';
import { SessionState, TranscriptItem, ChatMessage, ChatSession } from './types';
import { getAIInstance, encodeAudio, decodeAudio, decodeAudioData, getHinglishResponse } from './services/gemini';
import Visualizer from './components/Visualizer';
import Captions from './components/Captions';
import { Modality, LiveServerMessage } from '@google/genai';

const App: React.FC = () => {
  const [state, setState] = useState<SessionState>(SessionState.IDLE);
  const [ccEnabled, setCcEnabled] = useState(true);
  const [activeItem, setActiveItem] = useState<TranscriptItem | null>(null);
  const [toast, setToast] = useState<{message: string} | null>(null);
  const [inputText, setInputText] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
  const NOISE_GATE_THRESHOLD = 0.005; 
  const stateRef = useRef<SessionState>(SessionState.IDLE);
  
  // Separate accumulators to prevent combined bubbles
  const userInputAccumulator = useRef("");
  const aiOutputAccumulator = useRef("");
  
  const captionTimeoutRef = useRef<number | null>(null);
  const currentSessionTranscript = useRef<ChatMessage[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (chatHistory.length > 0) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory]);

  const showToast = (message: string) => {
    setToast({ message });
    setTimeout(() => setToast(null), 2500);
  };

  const startNewChat = () => {
    setChatHistory([]);
    setActiveSessionId(null);
    setIsSidebarOpen(false);
    currentSessionTranscript.current = [];
  };

  const loadSession = (session: ChatSession) => {
    setChatHistory(session.messages);
    setActiveSessionId(session.id);
    setIsSidebarOpen(false);
  };

  const updateSession = (messages: ChatMessage[]) => {
    if (messages.length === 0) return;
    setSessions(prev => {
      const existing = prev.find(s => s.id === activeSessionId);
      if (existing) {
        return prev.map(s => s.id === activeSessionId ? { ...s, messages } : s);
      } else {
        const newId = Date.now().toString();
        setActiveSessionId(newId);
        return [{
          id: newId,
          title: messages[messages.length - 1].text.slice(0, 30),
          messages,
          timestamp: Date.now()
        }, ...prev];
      }
    });
  };

  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
    }
  };

  const startLiveSession = async () => {
    await initAudio();
    setState(SessionState.LISTENING);
    currentSessionTranscript.current = [];
    userInputAccumulator.current = "";
    aiOutputAccumulator.current = "";
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ai = getAIInstance();
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(2048, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = { 
                data: encodeAudio(new Uint8Array(int16.buffer)), 
                mimeType: 'audio/pcm;rate=16000' 
              };
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(analyserRef.current!);
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (stateRef.current === SessionState.PAUSED) return;
            
            // Handle User Input Transcription
            if (message.serverContent?.inputTranscription) {
              if (captionTimeoutRef.current) window.clearTimeout(captionTimeoutRef.current);
              userInputAccumulator.current += message.serverContent.inputTranscription.text;
              setActiveItem({ 
                id: 'live-input', 
                type: 'hinglish', 
                spoken: userInputAccumulator.current, 
                displayed: userInputAccumulator.current, 
                translation: '', 
                confidence: 0.95, 
                timestamp: Date.now().toString(), 
                isAI: false 
              });
            }
            
            // Handle AI Output Transcription
            if (message.serverContent?.outputTranscription) {
              if (captionTimeoutRef.current) window.clearTimeout(captionTimeoutRef.current);
              aiOutputAccumulator.current += message.serverContent.outputTranscription.text;
              setActiveItem({ 
                id: 'live-output', 
                type: 'hinglish', 
                spoken: aiOutputAccumulator.current, 
                displayed: aiOutputAccumulator.current, 
                translation: '', 
                confidence: 1.0, 
                timestamp: Date.now().toString(), 
                isAI: true 
              });
            }
            
            // Handle Turn Completion - Push separate bubbles
            if (message.serverContent?.turnComplete) {
              // Push User Message if exists
              if (userInputAccumulator.current.trim()) {
                currentSessionTranscript.current.push({ 
                  id: Date.now().toString(), 
                  role: 'user', 
                  text: userInputAccumulator.current, 
                  isVoice: true 
                });
                userInputAccumulator.current = "";
              }
              
              // Push AI Message if exists
              if (aiOutputAccumulator.current.trim()) {
                currentSessionTranscript.current.push({ 
                  id: (Date.now() + 1).toString(), 
                  role: 'ai', 
                  text: aiOutputAccumulator.current, 
                  isVoice: true 
                });
                aiOutputAccumulator.current = "";
              }
              
              captionTimeoutRef.current = window.setTimeout(() => setActiveItem(null), 2000);
            }
            
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const outCtx = outAudioContextRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const audioBuffer = await decodeAudioData(decodeAudio(base64Audio), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outCtx.destination);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }
            if (message.serverContent?.interrupted) stopAllPlayback();
          },
          onerror: (e: ErrorEvent) => { setState(SessionState.ERROR); showToast("Connection error"); },
          onclose: (e: CloseEvent) => { if (stateRef.current !== SessionState.IDLE) setState(SessionState.IDLE); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          systemInstruction: `You are a helpful AI assistant. 
          Extremely important: Detect the language the user is speaking and respond in that exact language.
          - If the user speaks English, respond in English.
          - If the user speaks Hindi, respond in Hindi.
          - If the user speaks Hinglish (mixed), respond in Hinglish.
          Keep responses short, natural, and matching the user's conversational style.`,
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setState(SessionState.ERROR);
      showToast("Enable microphone permissions");
    }
  };

  const stopAllPlayback = () => {
    for (const s of sourcesRef.current) { try { s.stop(); } catch (e) {} }
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const handleSendMessage = async () => {
    if (!inputText.trim()) return;
    const text = inputText;
    setInputText("");
    const updatedHistory: ChatMessage[] = [...chatHistory, { id: Date.now().toString(), role: 'user', text }];
    setChatHistory(updatedHistory);
    const responseText = await getHinglishResponse(text);
    /**
     * Fix for type incompatibility error.
     * Explicitly typing finalHistory as ChatMessage[] ensures the 'role' property
     * matches the union type 'user' | 'ai' instead of widening to string.
     */
    const finalHistory: ChatMessage[] = [...updatedHistory, { id: (Date.now() + 1).toString(), role: 'ai', text: responseText || '' }];
    setChatHistory(finalHistory);
    updateSession(finalHistory);
  };

  const togglePause = () => {
    setState(prev => {
      const newState = prev === SessionState.PAUSED ? SessionState.LISTENING : SessionState.PAUSED;
      if (newState === SessionState.PAUSED) stopAllPlayback();
      return newState;
    });
  };

  const endSession = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    sessionRef.current?.close?.();
    stopAllPlayback();
    if (currentSessionTranscript.current.length > 0) {
      const newHistory = [...chatHistory, ...currentSessionTranscript.current];
      setChatHistory(newHistory);
      updateSession(newHistory);
    }
    setState(SessionState.IDLE);
    setActiveItem(null);
  };

  const MessageActions = () => (
    <div className="flex items-center gap-4 mt-3 text-white/40">
      <button className="hover:text-white transition-colors p-1"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg></button>
      <button className="hover:text-white transition-colors p-1"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg></button>
      <button className="hover:text-white transition-colors p-1"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.737 3h4.017c.163 0 .326.02.485.06L17 4m-7 10v5a2 2 0 002 2h.095c.5 0 .905-.405.905-.905 0-.714.211-1.412.608-2.006L17 13V4m-7 10h2m7-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"></path></svg></button>
      <button className="hover:text-white transition-colors p-1"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 15.536L12 12m0 0l-3.536-3.536M12 12l3.536-3.536M12 12l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></button>
      <button className="hover:text-white transition-colors p-1"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"></path></svg></button>
      <button className="hover:text-white transition-colors p-1"><svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black flex flex-col text-white overflow-hidden font-sans">
      {/* Sidebar Overlay */}
      <div className={`fixed inset-0 bg-black/50 backdrop-blur-sm z-[150] transition-opacity duration-300 ${isSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsSidebarOpen(false)} />
      <div className={`fixed top-0 left-0 bottom-0 w-72 bg-[#0d0d0d] z-[160] transition-transform duration-300 transform border-r border-white/5 flex flex-col ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-4 flex flex-col gap-4 h-full">
          <button onClick={startNewChat} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-white/10 hover:bg-white/5 transition-colors text-white font-medium">New Chat</button>
          <div className="flex-1 overflow-y-auto mt-4 space-y-1 custom-scrollbar">
            <h3 className="px-4 py-2 text-[11px] font-bold text-white/30 uppercase tracking-widest">Recent Chats</h3>
            {sessions.map((s) => (
              <button key={s.id} onClick={() => loadSession(s)} className={`w-full text-left px-4 py-3 rounded-lg text-sm truncate transition-colors ${activeSessionId === s.id ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}>
                {s.title}
              </button>
            ))}
          </div>
        </div>
      </div>

      {state === SessionState.IDLE && chatHistory.length === 0 ? (
        <>
          {/* Header Exactly as Screenshot */}
          <div className="w-full flex justify-between items-center px-6 py-6 shrink-0 relative z-50">
            <button onClick={() => setIsSidebarOpen(true)} className="w-8 h-8 flex flex-col items-start justify-center gap-1.5">
              <div className="w-6 h-0.5 bg-white/90" />
              <div className="w-6 h-0.5 bg-white/90" />
              <div className="w-6 h-0.5 bg-white/90" />
            </button>
            <div className="bg-[#1a1a1a] rounded-full px-5 py-2 flex items-center gap-1.5 border border-white/5">
              <span className="font-semibold text-[14px] text-white">ChatGPT</span>
              <span className="text-[14px] text-white/40">v4.0</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-transparent flex items-center justify-center border border-white/20">
                <svg className="w-4.5 h-4.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 4v16m8-8H4"></path></svg>
              </div>
              <div className="w-7 h-7 rounded-full bg-[#e84393] flex items-center justify-center text-[11px] font-bold text-white">U</div>
            </div>
          </div>

          {/* Main Home Area */}
          <div className="flex-1 flex flex-col items-center justify-center px-8 relative -mt-16">
            <div className="w-20 h-20 bg-white rounded-full mb-10 shadow-[0_0_30px_rgba(255,255,255,0.1)]" />
            <h1 className="text-[26px] font-semibold text-white mb-10 tracking-tight">What can I help with?</h1>
            
            <div className="w-full max-w-[360px] flex gap-3">
              <button className="flex-1 bg-[#1a1a1a] hover:bg-[#222] transition-colors rounded-2xl p-4 flex items-center gap-3 border border-white/5 group">
                <div className="w-8 h-8 rounded flex items-center justify-center text-emerald-500">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                </div>
                <span className="text-[14px] font-medium text-white/90">Create image</span>
              </button>
              <button className="flex-1 bg-[#1a1a1a] hover:bg-[#222] transition-colors rounded-2xl p-4 flex items-center gap-3 border border-white/5 group">
                <div className="w-8 h-8 rounded flex items-center justify-center text-orange-400">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                </div>
                <span className="text-[14px] font-medium text-white/90">Summarize text</span>
              </button>
            </div>
          </div>

          {/* Bottom Single Input Pill */}
          <div className="w-full max-w-2xl mx-auto px-6 pb-8">
            <div className="bg-[#1a1a1a] rounded-full flex items-center px-4 py-2 h-[60px] border border-white/5">
              <button className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white/70 mr-3 hover:bg-white/20 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 4v16m8-8H4"></path></svg>
              </button>
              <input 
                type="text" 
                value={inputText} 
                onChange={(e) => setInputText(e.target.value)} 
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()} 
                placeholder="Ask ChatGPT" 
                className="bg-transparent flex-1 outline-none text-[16px] text-white/90 placeholder:text-white/30" 
              />
              <div className="flex items-center gap-3 ml-2">
                <button className="text-white/30 hover:text-white/60 p-1 transition-colors">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                </button>
                <button onClick={startLiveSession} className="text-white hover:opacity-80 transition-opacity p-1">
                  <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="10" width="2" height="4" rx="1" />
                    <rect x="8" y="6" width="2" height="12" rx="1" />
                    <rect x="12" y="3" width="2" height="18" rx="1" />
                    <rect x="16" y="7" width="2" height="10" rx="1" />
                    <rect x="20" y="11" width="2" height="2" rx="1" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </>
      ) : state === SessionState.IDLE && chatHistory.length > 0 ? (
        <>
          {/* Active Chat Header */}
          <div className="w-full flex justify-between items-center px-4 py-4 shrink-0 relative z-50">
            <div className="flex items-center gap-2">
              <button onClick={() => setIsSidebarOpen(true)} className="w-10 h-10 rounded-full bg-[#1a1a1a] flex flex-col items-center justify-center gap-1.2 hover:bg-[#252525] transition-colors">
                <div className="w-5 h-0.5 bg-white/90 rounded-full mb-1" />
                <div className="w-5 h-0.5 bg-white/90 rounded-full" />
              </button>
              <div className="bg-[#1a1a1a] rounded-full px-5 py-2.5 flex items-center gap-1.5 border border-white/5">
                <span className="font-semibold text-[15px]">ChatGPT</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded-lg bg-transparent flex items-center justify-center border border-white/20">
                 <svg className="w-4.5 h-4.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 4v16m8-8H4"></path></svg>
               </div>
               <div className="w-7 h-7 rounded-full bg-[#e84393] flex items-center justify-center text-[11px] font-bold text-white">U</div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-2 custom-scrollbar flex flex-col">
            <div className="w-full max-w-3xl mx-auto space-y-10 py-6">
              {chatHistory.map((msg) => (
                <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-fade-in`}>
                  {msg.role === 'user' ? (
                    <div className="max-w-[85%]">
                      <div className="px-5 py-3 rounded-[24px] bg-[#212121] text-white/95 text-[16px] leading-relaxed shadow-sm">
                        {msg.text}
                      </div>
                      <div className="mt-2 text-right text-white/40 text-[12px] flex items-center justify-end gap-1.5 font-medium">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg> 
                        00:0{Math.floor(Math.random()*9+1)}
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-full w-full pr-10">
                      <div className="text-[#ececec] text-[16px] leading-[1.6] font-normal tracking-wide whitespace-pre-wrap ml-1">
                        {msg.text}
                      </div>
                      <MessageActions />
                    </div>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          </div>

          <div className="w-full max-w-3xl mx-auto p-4 shrink-0 flex flex-col gap-3">
             <div className="bg-[#1a1a1a] rounded-full flex items-center px-4 py-2 h-[60px] border border-white/5">
                <button className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white/70 mr-3 hover:bg-white/20 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 4v16m8-8H4"></path></svg>
                </button>
                <input 
                  type="text" 
                  value={inputText} 
                  onChange={(e) => setInputText(e.target.value)} 
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()} 
                  placeholder="Ask ChatGPT" 
                  className="bg-transparent flex-1 outline-none text-[16px] text-white/90 placeholder:text-white/30" 
                />
                <div className="flex items-center gap-3 ml-2">
                  <button className="text-white/30 hover:text-white/60 p-1 transition-colors">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                  </button>
                  <button onClick={startLiveSession} className="text-white hover:opacity-80 transition-opacity p-1">
                    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="4" y="10" width="2" height="4" rx="1" />
                      <rect x="8" y="6" width="2" height="12" rx="1" />
                      <rect x="12" y="3" width="2" height="18" rx="1" />
                      <rect x="16" y="7" width="2" height="10" rx="1" />
                      <rect x="20" y="11" width="2" height="2" rx="1" />
                    </svg>
                  </button>
                </div>
              </div>
          </div>
        </>
      ) : (
        /* Voice Mode View */
        <div className="flex-1 flex flex-col h-full bg-black">
          <div className="w-full flex justify-between items-center p-6 shrink-0 z-50">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center shadow-lg"><div className="w-4 h-4 bg-black rounded-full" /></div>
              <span className="font-semibold text-lg tracking-tight">ChatGPT</span>
              <span className="text-white/40 text-sm ml-2 font-medium">Advanced Voice</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center relative min-h-0">
            <Visualizer state={state} analyser={analyserRef.current} />
            <Captions activeTranscript={activeItem} visible={ccEnabled} />
          </div>
          <div className="w-full max-w-sm mx-auto px-6 pb-16 flex items-center justify-between animate-fade-in z-50 shrink-0">
            <button onClick={() => setCcEnabled(!ccEnabled)} className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${ccEnabled ? 'bg-white/10 border border-white/20' : 'text-white/30'}`}><span className="font-bold text-sm tracking-widest">CC</span></button>
            <button onClick={togglePause} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-2xl ${state === SessionState.PAUSED ? 'bg-white/10 border border-white/20' : 'bg-white'}`}>
              {state === SessionState.PAUSED ? (
                <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/></svg>
              ) : (
                <div className="flex gap-1.5 items-end">
                   <div className="w-1.5 h-6 bg-black rounded-full animate-pulse" />
                   <div className="w-1.5 h-10 bg-black rounded-full animate-pulse delay-75" />
                   <div className="w-1.5 h-8 bg-black rounded-full animate-pulse delay-150" />
                </div>
              )}
            </button>
            <button onClick={endSession} className="w-14 h-14 rounded-full bg-red-500/10 text-red-500 border border-red-500/30 flex items-center justify-center hover:bg-red-500 hover:text-white transition-all"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
          </div>
        </div>
      )}
      {toast && <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[210] px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/5 text-xs font-semibold">{toast.message}</div>}
    </div>
  );
};

export default App;