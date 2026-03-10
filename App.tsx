import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { decode, decodeAudioData } from './audioUtils';
import { UserProfile } from './types';

type AppState = 'DISCONNECTED' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ERROR';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>('DISCONNECTED');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
  
  const [transcript, setTranscript] = useState<{speaker: string, text: string}[]>([]);
  const [liveText, setLiveText] = useState<string>('');

  const chatRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  
  const appStateRef = useRef(appState);
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  const downloadTranscript = useCallback(() => {
    if (transcript.length === 0) {
      alert("No conversation to download.");
      return;
    }

    let content = `Session Transcript - Gemini Pro & ${userProfile.name}\n`;
    content += `Date: ${new Date().toLocaleString()}\n\n`;
    
    transcript.forEach(entry => {
      content += `${entry.speaker}: ${entry.text}\n\n`;
    });

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = userProfile.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    a.download = `gemini_transcript_${safeName}_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [transcript, userProfile.name]);

  const stopEverything = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch(e) {}
    }
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop(); } catch(e) {}
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    setAppState('DISCONNECTED');
  }, []);

  const playTTS = async (text: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        }
      });
      
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        if (!outputAudioCtxRef.current) {
          outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        }
        if (outputAudioCtxRef.current.state === 'suspended') {
          await outputAudioCtxRef.current.resume();
        }
        
        const buffer = await decodeAudioData(decode(base64Audio), outputAudioCtxRef.current, 24000, 1);
        const source = outputAudioCtxRef.current.createBufferSource();
        source.buffer = buffer;
        source.connect(outputAudioCtxRef.current.destination);
        audioSourceRef.current = source;
        
        source.start(0);
        
        source.onended = () => {
          if (appStateRef.current === 'SPEAKING') {
            startListening();
          }
        };
      } else {
        startListening();
      }
    } catch (err) {
      console.error("TTS Error", err);
      if (appStateRef.current === 'SPEAKING') {
        startListening();
      }
    }
  };

  const handleUserMessage = async (text: string) => {
    setAppState('THINKING');
    setLiveText('');
    setTranscript(prev => [...prev, { speaker: userProfile.name, text }]);
    
    try {
      const response = await chatRef.current.sendMessage({ message: text });
      const reply = response.text || "I'm not sure what to say.";
      
      setTranscript(prev => [...prev, { speaker: 'Gemini', text: reply }]);
      setAppState('SPEAKING');
      await playTTS(reply);
      
    } catch (err) {
      console.error("Chat Error", err);
      setErrorMessage("Failed to get response from Gemini.");
      setAppState('ERROR');
    }
  };

  const startListening = () => {
    setAppState('LISTENING');
    setLiveText('');
    
    if (!recognitionRef.current) {
      const SpeechRecognition = window.SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        setErrorMessage("Speech Recognition is not supported in this browser. Please use Chrome.");
        setAppState('ERROR');
        return;
      }
      
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        if (appStateRef.current !== 'LISTENING') return;
        
        let currentTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          currentTranscript += event.results[i][0].transcript;
        }
        setLiveText(currentTranscript);

        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        
        silenceTimerRef.current = setTimeout(() => {
          const finalString = currentTranscript.trim();
          if (finalString && appStateRef.current === 'LISTENING') {
            recognition.stop();
            handleUserMessage(finalString);
          }
        }, 2000); // 2 seconds of silence triggers send
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error", event.error);
        if (event.error === 'not-allowed') {
          setErrorMessage("Microphone access denied.");
          stopEverything();
        }
      };

      recognition.onend = () => {
        // Automatically restart if we are still supposed to be listening
        if (appStateRef.current === 'LISTENING') {
          try { recognition.start(); } catch (e) {}
        }
      };
      
      recognitionRef.current = recognition;
    }
    
    try {
      recognitionRef.current.start();
    } catch (e) {
      // Ignore if already started
    }
  };

  const initializeChat = async () => {
    try {
      setErrorMessage(null);
      
      if (window.aistudio) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await window.aistudio.openSelectKey();
        }
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      chatRef.current = ai.chats.create({
        model: "gemini-3.1-pro-preview",
        config: {
          systemInstruction: `You are an informative, helpful AI assistant. 
          You are chatting with ${userProfile.name}.
          ${userProfile.homeSituation ? `Home Situation: ${userProfile.homeSituation}.` : ''}
          ${userProfile.conversationTastes ? `Conversation Tastes: ${userProfile.conversationTastes}.` : ''}
          ${userProfile.thingsILike ? `Things they like: ${userProfile.thingsILike}.` : ''}
          
          Provide clear, informative, and well-structured answers. 
          IMPORTANT: Do not constantly prompt the user with questions to keep the conversation going. It is perfectly fine to simply answer their question and wait for them to speak again. Be helpful but not overly conversational or needy.`
        }
      });

      setIsInitialized(true);
      startListening();
      
    } catch (err) {
      console.error("Boot Failure:", err);
      setAppState('ERROR');
      setErrorMessage("System failed to initialize.");
    }
  };

  // Auto-scroll chat to bottom
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, liveText, appState]);

  if (!isInitialized) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-black-gradient p-6">
        <div className="w-full max-w-xl bg-slate-900/50 border border-white/10 rounded-[2.5rem] p-12 space-y-10 orange-glow">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <div className="w-20 h-20 bg-blue-500/10 rounded-full flex items-center justify-center border border-blue-500/20 pulse-animation">
                <i className="fa-solid fa-robot text-3xl text-blue-500"></i>
              </div>
            </div>
            <h1 className="text-4xl font-light tracking-tight text-white">Gemini Pro Audio</h1>
            <p className="text-slate-400 text-lg">Hands-free, informative AI assistant.</p>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); initializeChat(); }} className="space-y-6">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Your Name</label>
              <input 
                type="text" 
                value={userProfile.name}
                onChange={(e) => setUserProfile({...userProfile, name: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-blue-500/50 transition-colors"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Home Situation</label>
              <input 
                type="text" 
                placeholder="e.g., Living with 2 cats, noisy neighbors..."
                value={userProfile.homeSituation || ''}
                onChange={(e) => setUserProfile({...userProfile, homeSituation: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-blue-500/50 transition-colors"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Conversation Tastes</label>
              <input 
                type="text" 
                placeholder="e.g., Deep philosophical chats, light banter..."
                value={userProfile.conversationTastes || ''}
                onChange={(e) => setUserProfile({...userProfile, conversationTastes: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-blue-500/50 transition-colors"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500 uppercase tracking-widest px-2">Things I Like</label>
              <input 
                type="text" 
                placeholder="e.g., Sci-fi movies, baking bread..."
                value={userProfile.thingsILike || ''}
                onChange={(e) => setUserProfile({...userProfile, thingsILike: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 text-white focus:outline-none focus:border-blue-500/50 transition-colors"
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
              className="w-full py-5 bg-blue-500 hover:bg-blue-600 text-white font-bold text-xl rounded-3xl transition-all active:scale-[0.98] shadow-lg shadow-blue-500/20"
            >
              Start Session
            </button>
            
            <p className="text-center text-xs text-slate-600 uppercase tracking-widest">
              Powered by Gemini 3.1 Pro & Web Speech API
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
          <div className="w-10 h-10 bg-blue-500/10 rounded-full flex items-center justify-center border border-blue-500/20">
            <i className="fa-solid fa-robot text-blue-500"></i>
          </div>
          <div>
            <h2 className="text-lg font-medium text-white tracking-wide">Gemini Pro</h2>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${appState === 'LISTENING' ? 'bg-green-500 animate-pulse' : appState === 'THINKING' ? 'bg-yellow-500 animate-pulse' : appState === 'SPEAKING' ? 'bg-blue-500 animate-pulse' : 'bg-slate-500'}`}></div>
              <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-semibold">
                {appState === 'LISTENING' ? 'Listening...' : appState === 'THINKING' ? 'Thinking...' : appState === 'SPEAKING' ? 'Speaking...' : 'Disconnected'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button 
            onClick={stopEverything}
            className="px-5 h-12 bg-red-500/10 border border-red-500/20 rounded-full flex items-center justify-center text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors gap-2 font-medium"
          >
            <i className="fa-solid fa-right-from-bracket"></i>
            Exit
          </button>
        </div>
      </header>

      {/* Chat History */}
      <main className="flex-1 overflow-y-auto p-8 space-y-6 relative">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.03)_0%,transparent_70%)] pointer-events-none"></div>
        
        <div className="max-w-3xl mx-auto space-y-6 relative z-10 pb-20">
          {transcript.length === 0 && appState === 'LISTENING' && !liveText && (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 mt-20">
              <i className="fa-solid fa-microphone text-4xl mb-4 opacity-50"></i>
              <p>Go ahead and speak. I'm listening.</p>
            </div>
          )}

          {transcript.map((msg, i) => (
            <div key={i} className={`flex ${msg.speaker === 'Gemini' ? 'justify-start' : 'justify-end'}`}>
              <div className={`max-w-[85%] p-5 rounded-3xl ${msg.speaker === 'Gemini' ? 'bg-slate-800/80 border border-white/5 text-slate-200 rounded-tl-sm' : 'bg-blue-600 text-white rounded-tr-sm shadow-lg shadow-blue-500/10'}`}>
                <p className="text-[10px] uppercase tracking-wider opacity-50 mb-2 font-semibold">{msg.speaker}</p>
                <div className="leading-relaxed whitespace-pre-wrap">{msg.text}</div>
              </div>
            </div>
          ))}

          {appState === 'LISTENING' && liveText && (
            <div className="flex justify-end">
              <div className="max-w-[85%] p-5 rounded-3xl bg-blue-600/40 border border-blue-500/30 text-white/80 rounded-tr-sm italic">
                {liveText}
                <span className="inline-block w-1.5 h-4 ml-1 bg-white/50 animate-pulse align-middle"></span>
              </div>
            </div>
          )}

          {appState === 'THINKING' && (
            <div className="flex justify-start">
              <div className="p-5 rounded-3xl bg-slate-800/80 border border-white/5 text-slate-400 rounded-tl-sm flex gap-2 items-center h-[72px]">
                <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
              </div>
            </div>
          )}
          
          <div ref={chatEndRef} />
        </div>
      </main>

      {/* Footer Info */}
      <footer className="px-8 py-4 border-t border-white/5 bg-black/50 text-center z-10">
        <p className="text-[10px] text-slate-700 uppercase tracking-[0.4em]">
          Connected to {userProfile.name} • Gemini 3.1 Pro • Auto-Detect Speech
        </p>
      </footer>

      {/* Session Summary Modal */}
      {isInitialized && appState === 'DISCONNECTED' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          <div className="bg-slate-900 border border-white/10 rounded-3xl p-8 max-w-md w-full shadow-2xl flex flex-col items-center text-center gap-6">
            <div className="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center border border-blue-500/30">
              <i className="fa-solid fa-clipboard-check text-2xl text-blue-500"></i>
            </div>
            <div>
              <h3 className="text-2xl font-light text-white mb-2">Session Ended</h3>
              <p className="text-slate-400 text-sm">Your conversation has been disconnected.</p>
            </div>

            {errorMessage && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm flex items-center gap-3 w-full text-left">
                <i className="fa-solid fa-circle-exclamation"></i>
                {errorMessage}
              </div>
            )}
            
            <div className="w-full space-y-3 mt-2">
              <button 
                onClick={downloadTranscript}
                className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-2xl transition-colors flex items-center justify-center gap-3"
              >
                <i className="fa-solid fa-download"></i>
                Download Transcript
              </button>
              <button 
                onClick={() => {
                  setIsInitialized(false);
                  setTranscript([]);
                  setLiveText('');
                  setErrorMessage(null);
                }}
                className="w-full py-4 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-2xl transition-colors"
              >
                Return to Home
              </button>
              <button 
                onClick={() => {
                  if (window.confirm("Close the application?")) {
                    window.close();
                  }
                }}
                className="w-full py-3 bg-transparent hover:bg-white/5 text-slate-400 text-sm rounded-2xl transition-colors"
              >
                Exit App
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
