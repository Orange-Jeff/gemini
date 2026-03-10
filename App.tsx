import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, decodeAudioData, createPcmBlob } from './audioUtils';
import { UserProfile, ConnectionStatus } from './types';
import Waveform from './components/Waveform';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('social_gemini_profile');
    return saved ? JSON.parse(saved) : { 
      name: 'Friend', 
      interests: [], 
      relationship: 'Companion',
      homeSituation: '',
      conversationTastes: '',
      thingsILike: ''
    };
  });

  useEffect(() => {
    localStorage.setItem('social_gemini_profile', JSON.stringify(userProfile));
  }, [userProfile]);
  
  const [transcription, setTranscription] = useState<string>('');
  const [rmsInput, setRmsInput] = useState(0);
  const [rmsOutput, setRmsOutput] = useState(0);

  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const isMutedRef = useRef(false);

  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  const stopEverything = useCallback(() => {
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const initializeZephyr = async () => {
    try {
      setErrorMessage(null);
      setStatus(ConnectionStatus.CONNECTING);

      // 1. API Key Pre-flight
      if (window.aistudio) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await window.aistudio.openSelectKey();
          // Proceed immediately after calling openSelectKey to handle the race condition
        }
      }

      // 2. Warm up Audio Contexts (Atomic step within user gesture)
      if (!inputAudioCtxRef.current) {
        inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      }
      if (!outputAudioCtxRef.current) {
        outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      }
      
      await inputAudioCtxRef.current.resume();
      await outputAudioCtxRef.current.resume();

      // 3. Requesting Signal (Mic)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // 4. Establishing Link
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: `You are Zephyr. You are a witty, relaxed conversationalist. 
          You are chatting with ${userProfile.name} (Designation: ${userProfile.relationship}).
          ${userProfile.homeSituation ? `Home Situation: ${userProfile.homeSituation}.` : ''}
          ${userProfile.conversationTastes ? `Conversation Tastes: ${userProfile.conversationTastes}.` : ''}
          ${userProfile.thingsILike ? `Things they like: ${userProfile.thingsILike}.` : ''}
          Be warm, concise, and sound like a person. Mention user details naturally but sparingly.
          Humor is encouraged, especially dry wit. If there's a silence, wait patiently.`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsInitialized(true);
            
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const processor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              if (isMutedRef.current) { setRmsInput(0); return; }

              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setRmsInput(Math.sqrt(sum / inputData.length));

              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };

            source.connect(processor);
            processor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const base64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64) {
              const buffer = await decodeAudioData(decode(base64), outputAudioCtxRef.current!, OUTPUT_SAMPLE_RATE, 1);
              const source = outputAudioCtxRef.current!.createBufferSource();
              source.buffer = buffer;
              source.connect(outputAudioCtxRef.current!.destination);
              
              setRmsOutput(0.9);
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioCtxRef.current!.currentTime);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              
              sourcesRef.current.add(source);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setRmsOutput(0);
              };
            }

            const text = msg.serverContent?.modelTurn?.parts?.[0]?.text || 
                         msg.serverContent?.outputTranscription?.text;
            if (text) setTranscription(text);

            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error("Signal Lost:", e);
            setErrorMessage("The link was severed. Check your connection or API key.");
            if (e.toString().includes('404')) {
              window.aistudio?.openSelectKey();
            }
            stopEverything();
          },
          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
            stopEverything();
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Boot Failure:", err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMessage("System failed to initialize. Microphone or subspace interference.");
    }
  };

  if (!isInitialized) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-black-gradient p-6">
        <div className="w-full max-w-xl bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-12 space-y-10 orange-glow">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <div className="w-20 h-20 bg-orange-500/10 rounded-full flex items-center justify-center border border-orange-500/20 pulse-animation">
                <i className="fa-solid fa-satellite-dish text-3xl text-orange-500"></i>
              </div>
            </div>
            <h1 className="text-4xl font-light tracking-tight text-white">Zephyr Link</h1>
            <p className="text-slate-400 text-lg">Establishing a direct neural-audio connection.</p>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); initializeZephyr(); }} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Operator Name</label>
                <input 
                  type="text" 
                  value={userProfile.name}
                  onChange={(e) => setUserProfile({...userProfile, name: e.target.value})}
                  className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-orange-500/50 transition-colors"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Designation</label>
                <input 
                  type="text" 
                  value={userProfile.relationship}
                  onChange={(e) => setUserProfile({...userProfile, relationship: e.target.value})}
                  className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-orange-500/50 transition-colors"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Home Situation</label>
              <input 
                type="text" 
                placeholder="e.g., Living with 2 cats, noisy neighbors..."
                value={userProfile.homeSituation || ''}
                onChange={(e) => setUserProfile({...userProfile, homeSituation: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-orange-500/50 transition-colors"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Conversation Tastes</label>
              <input 
                type="text" 
                placeholder="e.g., Deep philosophical chats, light banter..."
                value={userProfile.conversationTastes || ''}
                onChange={(e) => setUserProfile({...userProfile, conversationTastes: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-orange-500/50 transition-colors"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Things I Like</label>
              <input 
                type="text" 
                placeholder="e.g., Sci-fi movies, baking bread..."
                value={userProfile.thingsILike || ''}
                onChange={(e) => setUserProfile({...userProfile, thingsILike: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-orange-500/50 transition-colors"
              />
            </div>

            {errorMessage && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm flex items-center gap-3">
                <i className="fa-solid fa-circle-exclamation"></i>
                {errorMessage}
              </div>
            )}

            <button 
              type="submit"
              disabled={status === ConnectionStatus.CONNECTING}
              className="w-full py-5 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold text-xl rounded-3xl transition-all active:scale-[0.98] shadow-lg shadow-orange-500/20"
            >
              {status === ConnectionStatus.CONNECTING ? 'Calibrating...' : 'Initiate Link'}
            </button>
            
            <p className="text-center text-xs text-slate-600 uppercase tracking-widest">
              Gemini Native Audio Engine v2.5-Flash
            </p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-black overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-6 border-b border-white/5 bg-black/50 backdrop-blur-xl z-10">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-orange-500/10 rounded-full flex items-center justify-center border border-orange-500/20">
            <i className="fa-solid fa-wind text-orange-500"></i>
          </div>
          <div>
            <h2 className="text-lg font-medium text-white tracking-wide">Zephyr</h2>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
              <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-semibold">Neural Link Active</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button 
            onClick={() => setIsMuted(!isMuted)}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${isMuted ? 'bg-red-500/20 text-red-500 border-red-500/30' : 'bg-white/5 text-slate-400 border-white/10'} border`}
          >
            <i className={`fa-solid ${isMuted ? 'fa-microphone-slash' : 'fa-microphone'}`}></i>
          </button>
          <button 
            onClick={stopEverything}
            className="w-12 h-12 bg-white/5 border border-white/10 rounded-full flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          >
            <i className="fa-solid fa-power-off"></i>
          </button>
        </div>
      </header>

      {/* Main Conversation Visualizer */}
      <main className="flex-1 flex flex-col items-center justify-center p-8 relative">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(249,115,22,0.05)_0%,transparent_70%)]"></div>
        
        <div className="w-full max-w-2xl flex flex-col items-center gap-12 z-10">
          <div className="space-y-4 w-full text-center">
            <p className="text-slate-500 text-xs uppercase tracking-[0.3em] font-medium">Subspace Waveform</p>
            <div className="w-full bg-slate-900/40 border border-white/5 rounded-[2rem] p-10 flex flex-col gap-6">
              <Waveform isActive={status === ConnectionStatus.CONNECTED} color="#f97316" amplitude={rmsOutput || rmsInput} />
            </div>
          </div>

          <div className="w-full text-center min-h-[100px] flex flex-col justify-center gap-4">
            <p className="text-slate-600 text-[10px] uppercase tracking-widest font-bold">Transcription Stream</p>
            <p className="text-2xl text-slate-300 font-light leading-relaxed italic">
              {transcription || "Listening for your voice..."}
            </p>
          </div>
        </div>
      </main>

      {/* Footer Info */}
      <footer className="px-8 py-4 border-t border-white/5 bg-black/50 text-center">
        <p className="text-[10px] text-slate-700 uppercase tracking-[0.4em]">
          Connected to {userProfile.name} • Protocol Level 4 • No Vogon Filing Required
        </p>
      </footer>
    </div>
  );
};

export default App;