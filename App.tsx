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
  const [voiceSessionEnded, setVoiceSessionEnded] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [selectedFeedback, setSelectedFeedback] = useState<string[]>([]);
  
  const stateRef = useRef<SessionState>(SessionState.IDLE);
  const currentTranscriptionRef = useRef("");
  const currentSessionTranscript = useRef<ChatMessage[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const showToast = (message: string) => {
    setToast({ message });
    setTimeout(() => setToast(null), 2500);
  };

  const startNewChat = () => {
    setChatHistory([]);
    setActiveSessionId(null);
    setVoiceSessionEnded(false);
    setIsSidebarOpen(false);
  };

  const loadSession = (session: ChatSession) => {
    setChatHistory(session.messages);
    setActiveSessionId(session.id);
    setVoiceSessionEnded(false);
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
          title: messages[0].text.slice(0, 30) + (messages[0].text.length > 30 ? '...' : ''),
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
    setVoiceSessionEnded(false);
    setShowFeedbackModal(false);
    currentSessionTranscript.current = [];
    currentTranscriptionRef.current = "";
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const ai = getAIInstance();
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
              if (stateRef.current !== SessionState.LISTENING) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encodeAudio(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then((session: any) => session.sendRealtimeInput({ media: pcmBlob }));
            };

            source.connect(analyserRef.current!);
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (stateRef.current === SessionState.PAUSED) return;

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              currentTranscriptionRef.current += text;
              setActiveItem({
                id: 'live-input', type: 'hinglish', spoken: currentTranscriptionRef.current,
                displayed: currentTranscriptionRef.current, translation: '', confidence: 0.95,
                timestamp: Date.now().toString(), isAI: false
              });
            }

            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              currentTranscriptionRef.current += text;
              setActiveItem({
                id: 'live-output', type: 'hinglish', spoken: currentTranscriptionRef.current,
                displayed: currentTranscriptionRef.current, translation: '', confidence: 1.0,
                timestamp: Date.now().toString(), isAI: true
              });
            }

            if (message.serverContent?.turnComplete) {
              if (currentTranscriptionRef.current.trim()) {
                currentSessionTranscript.current.push({
                  id: Date.now().toString(),
                  role: message.serverContent?.modelTurn ? 'ai' : 'user',
                  text: currentTranscriptionRef.current,
                  isVoice: true
                });
              }
              currentTranscriptionRef.current = "";
              setActiveItem(null);
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
          onerror: (e: any) => console.error("Live Error", e),
          onclose: () => console.log("Live Closed")
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: "You are a helpful Hinglish speaking AI assistant. Keep responses very short and natural.",
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
    setVoiceSessionEnded(false);
    
    const responseText = await getHinglishResponse(text);
    const finalHistory: ChatMessage[] = [...updatedHistory, { id: (Date.now() + 1).toString(), role: 'ai', text: responseText }];
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
    setVoiceSessionEnded(true);
  };

  const handleThumbsUp = () => { setVoiceSessionEnded(false); showToast("Thanks for the feedback!"); };
  const handleThumbsDown = () => setShowFeedbackModal(true);
  const submitFeedback = () => { setVoiceSessionEnded(false); setShowFeedbackModal(false); setSelectedFeedback([]); showToast("Feedback submitted. Thank you!"); };
  const toggleFeedbackOption = (option: string) => { setSelectedFeedback(prev => prev.includes(option) ? prev.filter(o => o !== option) : [...prev, option]); };

  const Sidebar = () => (
    <>
      <div 
        className={`fixed inset-0 bg-black/50 backdrop-blur-sm z-[150] transition-opacity duration-300 ${isSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setIsSidebarOpen(false)}
      />
      <div className={`fixed top-0 left-0 bottom-0 w-72 bg-[#0d0d0d] z-[160] transition-transform duration-300 transform border-r border-white/5 flex flex-col ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-4 flex flex-col gap-4 h-full">
          <button 
            onClick={startNewChat}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-white/10 hover:bg-white/5 transition-colors text-white font-medium group"
          >
            <div className="w-6 h-6 rounded-full border border-white/20 flex items-center justify-center group-hover:border-white/40">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
            </div>
            New Chat
          </button>
          <div className="flex-1 overflow-y-auto mt-4 space-y-1">
            <h3 className="px-4 py-2 text-[11px] font-bold text-white/30 uppercase tracking-widest">Recent Chats</h3>
            {sessions.map((s) => (
              <button key={s.id} onClick={() => loadSession(s)} className={`w-full text-left px-4 py-3 rounded-lg text-sm truncate transition-colors ${activeSessionId === s.id ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}>
                {s.title}
              </button>
            ))}
            {sessions.length === 0 && <p className="px-4 py-4 text-xs text-white/20 italic">No previous chats yet</p>}
          </div>
          <div className="mt-auto border-t border-white/5 pt-4">
             <button onClick={() => { setIsSidebarOpen(false); startNewChat(); }} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-white/60 hover:text-white hover:bg-white/5 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
                <span className="text-sm font-medium">Home</span>
             </button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="fixed inset-0 bg-black flex flex-col text-white">
      <Sidebar />
      {state === SessionState.IDLE ? (
        <>
          <div className="w-full flex justify-between items-center px-4 pt-6 pb-2 shrink-0 relative z-50">
            <button onClick={() => setIsSidebarOpen(true)} className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M4 18h16c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zm0-5h16c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zM3 7c0 .55.45 1 1 1h16c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1z"/></svg>
            </button>
            <div className="flex items-center gap-1 bg-white/5 rounded-full px-4 py-2 border border-white/5">
              <span className="font-semibold text-[15px]">ChatGPT</span>
            </div>
            <div className="w-10 h-10" /> 
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col items-center">
            {chatHistory.length === 0 ? (
              <div className="mt-32 text-center animate-fade-in flex flex-col items-center">
                <h1 className="text-3xl font-semibold mb-2">What can I help with?</h1>
              </div>
            ) : (
              <div className="w-full max-w-2xl space-y-10 pt-8 pb-10">
                {chatHistory.map((msg) => (
                  <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-fade-in`}>
                    <div className={`max-w-[85%] px-5 py-3.5 rounded-[22px] ${msg.role === 'user' ? 'bg-[#2f2f2f]' : ''} text-white/95 text-[16px]`}>
                      {msg.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="w-full max-w-2xl mx-auto p-4 flex flex-col items-center gap-3 shrink-0">
            {voiceSessionEnded && (
              <div className="w-full bg-[#171717] border border-white/5 rounded-2xl px-5 py-3.5 mb-2 flex items-center justify-between animate-fade-in shadow-xl">
                 <span className="text-[15px] font-medium text-white/70">Voice chat ended</span>
                 <div className="flex items-center gap-3">
                    <button onClick={handleThumbsUp} className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors">👍</button>
                    <button onClick={handleThumbsDown} className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors">👎</button>
                 </div>
              </div>
            )}
            <div className="w-full flex items-center gap-3">
              <div className="flex-1 bg-[#171717] rounded-[28px] flex items-center px-4 py-2.5 border border-white/10 shadow-lg">
                <input 
                  type="text" 
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Ask ChatGPT"
                  className="bg-transparent flex-1 outline-none text-[16px] text-white/90"
                />
                <button onClick={startLiveSession} className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center">🎙️</button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col">
          <div className="flex-1 flex flex-col items-center justify-center relative">
            <Visualizer state={state} analyser={analyserRef.current} />
            <Captions activeTranscript={activeItem} visible={ccEnabled} />
          </div>
          <div className="w-full max-sm mx-auto px-6 pb-16 flex items-center justify-between animate-fade-in z-50 shrink-0">
            <button onClick={() => setCcEnabled(!ccEnabled)} className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${ccEnabled ? 'bg-white/10 border border-white/20' : 'text-white/30'}`}><span className="font-bold text-sm">CC</span></button>
            <button onClick={togglePause} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${state === SessionState.PAUSED ? 'bg-white/10' : 'bg-white'}`}>
              {state === SessionState.PAUSED ? "▶️" : "⏸️"}
            </button>
            <button onClick={endSession} className="w-14 h-14 rounded-full bg-red-500/10 text-red-500 border border-red-500/30 flex items-center justify-center">✖️</button>
          </div>
        </div>
      )}
      {showFeedbackModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-[#41545e] w-full max-w-md rounded-[32px] p-6 text-center flex flex-col gap-6">
            <h2 className="text-xl font-semibold text-white">What went wrong?</h2>
            <button onClick={submitFeedback} className="w-full py-4 rounded-full bg-[#d0dbe1] text-[#2c3a41] font-bold">Submit</button>
          </div>
        </div>
      )}
      {toast && <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[210] animate-fade-in"><div className="px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/5 text-xs text-white shadow-2xl">{toast.message}</div></div>}
    </div>
  );
};

export default App;