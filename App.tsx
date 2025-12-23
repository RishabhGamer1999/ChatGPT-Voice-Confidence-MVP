
import React, { useState, useEffect, useRef } from 'react';
import { SessionState, TranscriptItem, ChatMessage, ChatSession } from './types';
import { MODEL_CONFIG } from './constants';
import { getAIInstance, encodeAudio, decodeAudio, decodeAudioData, getHinglishResponse } from './services/gemini';
import Visualizer from './components/Visualizer';
import Captions from './components/Captions';
import { Modality } from '@google/genai';

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
  
  // Refs for state synchronization in real-time callbacks
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

  // Keep stateRef in sync with state
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const showToast = (message: string) => {
    setToast({ message });
    setTimeout(() => setToast(null), 2500);
  };

  const startNewChat = () => {
    // If current chat has messages, we should have already "saved" it when switching or starting new
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
            
            scriptProcessor.onaudioprocess = (e) => {
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
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };

            source.connect(analyserRef.current!);
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message) => {
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

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
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
          }
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
    sessionRef.current?.close();
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
              <button 
                key={s.id}
                onClick={() => loadSession(s)}
                className={`w-full text-left px-4 py-3 rounded-lg text-sm truncate transition-colors ${activeSessionId === s.id ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
              >
                {s.title}
              </button>
            ))}
            {sessions.length === 0 && (
              <p className="px-4 py-4 text-xs text-white/20 italic">No previous chats yet</p>
            )}
          </div>

          <div className="mt-auto border-t border-white/5 pt-4">
             <button 
              onClick={() => { setIsSidebarOpen(false); startNewChat(); }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-white/60 hover:text-white hover:bg-white/5 transition-colors"
             >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
                <span className="text-sm font-medium">Home</span>
             </button>
             <div className="flex items-center gap-3 px-4 py-3 mt-2">
                <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-black">JD</div>
                <div className="flex-1 truncate">
                   <p className="text-xs font-semibold text-white">John Doe</p>
                   <p className="text-[10px] text-white/40">Free Plan</p>
                </div>
                <svg className="w-4 h-4 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"></path></svg>
             </div>
          </div>
        </div>
      </div>
    </>
  );

  const FeedbackModal = () => (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-[#41545e] w-full max-w-md rounded-t-[32px] sm:rounded-[32px] p-6 text-center flex flex-col gap-6 shadow-2xl relative">
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto sm:hidden" />
        <div>
          <h2 className="text-xl font-semibold text-white">What went wrong?</h2>
          <p className="text-white/60 text-sm mt-1">Select all that apply</p>
        </div>
        <div className="space-y-2.5">
          {["It misheard me", "Audio issues", "I didn't like the responses", "It couldn't hear me", "It interrupted me", "Other"].map((option) => (
            <button key={option} onClick={() => toggleFeedbackOption(option)} className={`w-full flex items-center justify-between p-4 rounded-xl transition-all border ${selectedFeedback.includes(option) ? 'bg-white/10 border-white/20' : 'bg-white/5 border-transparent hover:bg-white/10'}`}>
              <span className="text-white/90 font-medium">{option}</span>
              <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-colors ${selectedFeedback.includes(option) ? 'bg-white border-white' : 'border-white/20'}`}>
                {selectedFeedback.includes(option) && <svg className="w-4 h-4 text-[#41545e]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>}
              </div>
            </button>
          ))}
        </div>
        <button onClick={submitFeedback} disabled={selectedFeedback.length === 0} className={`w-full py-4 rounded-full font-bold text-lg transition-all ${selectedFeedback.length > 0 ? 'bg-[#d0dbe1] text-[#2c3a41]' : 'bg-white/5 text-white/20 cursor-not-allowed'}`}>Submit feedback</button>
      </div>
    </div>
  );

  const HomeHeader = () => (
    <div className="w-full flex justify-between items-center px-4 pt-6 pb-2 shrink-0 relative z-50">
      <button 
        onClick={() => setIsSidebarOpen(true)}
        className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors"
      >
        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M4 18h16c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zm0-5h16c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zM3 7c0 .55.45 1 1 1h16c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1z"/></svg>
      </button>
      <div className="flex items-center gap-1 bg-white/5 rounded-full px-4 py-2 border border-white/5 cursor-pointer hover:bg-white/10 transition-colors">
        <span className="font-semibold text-[15px]">ChatGPT</span>
        <svg className="w-4 h-4 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
      </div>
      <div className="flex gap-2">
        <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 cursor-pointer">
           <svg className="w-5 h-5 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"></path></svg>
        </div>
        <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 cursor-pointer">
          <svg className="w-5 h-5 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"></path></svg>
        </div>
      </div>
    </div>
  );

  const MessageActions = () => (
    <div className="flex items-center gap-4 mt-2 text-white/30">
      <button className="hover:text-white transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg></button>
      <button className="hover:text-white transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg></button>
      <button className="hover:text-white transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.737 3h4.017c.163 0 .326.02.485.06L17 4m-7 10v5a2 2 0 002 2h.095c.5 0 .905-.405.905-.905 0-.714.211-1.412.608-2.006L17 13V4m-7 10h2m7-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"></path></svg></button>
      <button className="hover:text-white transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></button>
      <button className="hover:text-white transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"></path></svg></button>
    </div>
  );

  const InputBar = () => (
    <div className="w-full max-w-2xl mx-auto p-4 flex flex-col items-center gap-3 shrink-0">
      {voiceSessionEnded && (
        <div className="w-full bg-[#171717] border border-white/5 rounded-2xl px-5 py-3.5 mb-2 flex items-center justify-between animate-fade-in shadow-xl">
           <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
              <span className="text-[15px] font-medium text-white/70">Voice chat ended</span>
           </div>
           <div className="flex items-center gap-3">
              <button onClick={handleThumbsUp} className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 text-white/60 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg>
              </button>
              <button onClick={handleThumbsDown} className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 text-white/60 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.737 3h4.017c.163 0 .326.02.485.06L17 4m-7 10v5a2 2 0 002 2h.095c.5 0 .905-.405.905-.905 0-.714.211-1.412.608-2.006L17 13V4m-7 10h2m7-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"></path></svg>
              </button>
           </div>
        </div>
      )}
      <div className="w-full flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center shrink-0 border border-white/10 hover:bg-white/10 cursor-pointer transition-colors">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
        </div>
        <div className="flex-1 bg-[#171717] rounded-[28px] flex items-center px-4 py-2.5 border border-white/10 shadow-lg">
          <input 
            type="text" 
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
            placeholder="Ask ChatGPT"
            className="bg-transparent flex-1 outline-none text-[16px] text-white/90 placeholder:text-white/30"
          />
          <div className="flex items-center gap-3">
            <button className="text-white/40 hover:text-white transition-colors">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
            </button>
            <button 
              onClick={startLiveSession}
              className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
            >
              <div className="flex gap-0.5 items-end h-4">
                <div className="w-1 h-3 bg-white/80 rounded-full animate-pulse"></div>
                <div className="w-1 h-4 bg-white/80 rounded-full animate-pulse delay-75"></div>
                <div className="w-1 h-2 bg-white/80 rounded-full animate-pulse delay-150"></div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black flex flex-col text-white">
      <Sidebar />
      {state === SessionState.IDLE ? (
        <>
          <HomeHeader />
          <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col items-center">
            {chatHistory.length === 0 ? (
              <div className="mt-32 text-center animate-fade-in flex flex-col items-center">
                <div className="w-16 h-16 rounded-full border border-white/10 flex items-center justify-center mb-6">
                   <svg className="w-8 h-8 text-white/80" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>
                </div>
                <h1 className="text-3xl font-semibold mb-2">What can I help with?</h1>
                <div className="flex flex-wrap justify-center gap-2 mt-8 px-4 animate-fade-in">
                  <button className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/5 px-4 py-2.5 rounded-2xl transition-all">
                    <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                    <span className="text-[14px] font-medium opacity-80">Create image</span>
                  </button>
                  <button className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/5 px-4 py-2.5 rounded-2xl transition-all">
                    <svg className="w-4 h-4 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                    <span className="text-[14px] font-medium opacity-80">Summarize text</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="w-full max-w-2xl space-y-10 pt-8 pb-10">
                {chatHistory.map((msg) => (
                  <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-fade-in`}>
                    {msg.role === 'user' ? (
                      <div className="max-w-[85%] px-5 py-3.5 rounded-[22px] bg-[#2f2f2f] text-white/95 text-[16px] shadow-sm">
                        {msg.isVoice && <span className="text-[10px] uppercase font-bold text-white/30 block mb-1">Voice Input</span>}
                        {msg.text}
                      </div>
                    ) : (
                      <div className="max-w-[95%] w-full">
                         <div className="text-white/90 text-[16px] whitespace-pre-wrap pl-1">{msg.text}</div>
                         <MessageActions />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <InputBar />
        </>
      ) : (
        <div className="flex-1 flex flex-col">
          <div className="w-full flex justify-between items-center p-6 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center"><div className="w-4 h-4 bg-black rounded-full" /></div>
              <span className="font-semibold text-lg tracking-tight">ChatGPT</span>
              <span className="text-white/40 text-sm font-medium ml-2">Advanced Voice</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center relative">
            <Visualizer state={state} analyser={analyserRef.current} />
            <Captions activeTranscript={activeItem} visible={ccEnabled} />
          </div>
          <div className="w-full max-sm mx-auto px-6 pb-16 flex items-center justify-between animate-fade-in z-50 shrink-0">
            <button onClick={() => setCcEnabled(!ccEnabled)} className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${ccEnabled ? 'bg-white/10 border border-white/20 shadow-lg' : 'bg-transparent text-white/30 border border-white/10'}`}><span className="font-bold text-sm">CC</span></button>
            <button onClick={togglePause} className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${state === SessionState.PAUSED ? 'bg-white/10 border border-white/20' : 'bg-white shadow-2xl'}`}>
              {state === SessionState.PAUSED ? <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/></svg> : <div className="flex gap-1.5 items-center justify-center h-full"><div className="w-1.5 h-8 bg-black rounded-full animate-pulse" /><div className="w-1.5 h-10 bg-black rounded-full animate-pulse delay-75" /><div className="w-1.5 h-8 bg-black rounded-full animate-pulse delay-150" /></div>}
            </button>
            <button onClick={endSession} className="w-14 h-14 rounded-full bg-red-500/10 text-red-500 border border-red-500/30 flex items-center justify-center hover:bg-red-500 hover:text-white transition-all shadow-lg active:scale-90"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
          </div>
        </div>
      )}
      {showFeedbackModal && <FeedbackModal />}
      {toast && <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[210] animate-fade-in pointer-events-none"><div className="px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/5 text-xs font-semibold text-white/70 shadow-2xl">{toast.message}</div></div>}
    </div>
  );
};

export default App;
