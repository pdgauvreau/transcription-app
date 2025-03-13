import React, { useState, useEffect, useRef } from "react";

const MeetingTranscription = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [currentSpeakerId, setCurrentSpeakerId] = useState(1);
  const [error, setError] = useState("");
  const [debugLog, setDebugLog] = useState([]);
  
  const micStreamRef = useRef(null);
  const socketRef = useRef(null);
  const recognitionRef = useRef(null);
  const speakerFeaturesRef = useRef({});
  const lastSpeakerRef = useRef(null);
  const silenceTimeoutRef = useRef(null);
  
  // Replace with your Google Cloud API key
  const GOOGLE_API_KEY = "APIKEYHERE";
  
  // Add debug logging
  const addLog = (message) => {
    console.log(message);
    setDebugLog(prev => [...prev, { time: new Date().toISOString(), message }]);
  };
  
  // Start streaming audio to Google Cloud Speech-to-Text API
  const startStreaming = async (stream) => {
    try {
      // Stop any existing stream
      if (socketRef.current) {
        stopRecording();
      }
      
      addLog("Starting audio stream");
      
      // Store the stream
      micStreamRef.current = stream;
      
      // Create WebSocket connection
      const socketUrl = `wss://speech.googleapis.com/v1p1beta1/speech:streamingRecognize?key=${GOOGLE_API_KEY}`;
      addLog(`Connecting to WebSocket: ${socketUrl}`);
      
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;
      
      // Set up WebSocket event handlers
      socket.onopen = () => {
        addLog("WebSocket connection opened");
        
        // Send configuration message
        const configMessage = {
          streamingConfig: {
            config: {
              encoding: "LINEAR16",
              sampleRateHertz: 16000,
              languageCode: "en-US",
              enableAutomaticPunctuation: true,
              enableSpeakerDiarization: true,
              diarizationSpeakerCount: 2,
              model: "default",
              useEnhanced: true
            },
            interimResults: true
          }
        };
        
        addLog("Sending config: " + JSON.stringify(configMessage));
        socket.send(JSON.stringify(configMessage));
        
        // Set up audio processing
        setupAudioProcessing(stream, socket);
      };
      
      socket.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data);
          addLog("Received response: " + JSON.stringify(response));
          
          // Handle recognition results
          if (response.results && response.results.length > 0) {
            const result = response.results[0];
            
            if (result.alternatives && result.alternatives.length > 0) {
              const text = result.alternatives[0].transcript;
              addLog(`Recognized text: ${text}`);
              
              if (text && text.trim() !== "") {
                if (result.isFinal) {
                  addLog("Final result received");
                  detectSpeakerChange(text.trim());
                }
              }
            }
          } else if (response.error) {
            setError(`API Error: ${response.error.message}`);
            addLog(`API Error: ${JSON.stringify(response.error)}`);
          }
        } catch (err) {
          addLog(`Error parsing message: ${err.message}`);
        }
      };
      
      socket.onerror = (err) => {
        const errorMessage = err.message || "Unknown WebSocket error";
        addLog(`WebSocket error: ${errorMessage}`);
        setError(`Speech recognition error: ${errorMessage}`);
      };
      
      socket.onclose = (event) => {
        addLog(`WebSocket closed: ${event.code} - ${event.reason}`);
        
        if (isRecording && event.code !== 1000) {
          // Try to reconnect if this wasn't intentional
          addLog("Attempting to reconnect...");
          setTimeout(() => {
            if (isRecording && micStreamRef.current) {
              startStreaming(micStreamRef.current);
            }
          }, 2000);
        }
      };
      
      setIsRecording(true);
      
    } catch (err) {
      addLog(`Error in startStreaming: ${err.message}`);
      setError(`Error starting streaming: ${err.message}`);
    }
  };
  
  // Set up audio processing for streaming
  const setupAudioProcessing = (stream, socket) => {
    try {
      addLog("Setting up audio processing");
      
      // Create audio context for processing
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000 // Match the sample rate with our config
      });
      
      const source = audioContext.createMediaStreamSource(stream);
      
      // Create script processor for audio streaming
      const bufferSize = 4096;
      const recorder = audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      // Connect the nodes
      source.connect(recorder);
      recorder.connect(audioContext.destination);
      
      // Process audio data
      recorder.onaudioprocess = (e) => {
        if (socket.readyState === 1) {
          // Get audio data
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Convert float32 to int16
          const int16Data = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            // Convert float [-1.0, 1.0] to int16 [-32768, 32767]
            int16Data[i] = Math.min(1, Math.max(-1, inputData[i])) * 32767;
          }
          
          // Convert to base64
          const base64Data = arrayBufferToBase64(int16Data.buffer);
          
          // Send audio data
          const audioMessage = {
            audioContent: base64Data
          };
          
          socket.send(JSON.stringify(audioMessage));
        }
      };
      
      // Store for cleanup
      recognitionRef.current = {
        audioContext,
        source,
        recorder
      };
      
      // Create analyser for speaker detection
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      
      // Process audio for speaker detection
      const detectSpeaker = () => {
        if (!analyser) return;
        
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        processAudioFeatures(data);
        
        if (isRecording) {
          requestAnimationFrame(detectSpeaker);
        }
      };
      
      detectSpeaker();
      
    } catch (err) {
      addLog(`Error in setupAudioProcessing: ${err.message}`);
      setError(`Error processing audio: ${err.message}`);
    }
  };
  
  // Helper: Convert ArrayBuffer to Base64
  const arrayBufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };
  
  // Process audio features for speaker identification
  const processAudioFeatures = (dataArray) => {
    if (!dataArray || dataArray.length === 0) return;
    
    // Extract audio features
    const features = extractAudioFeatures(dataArray);
    
    // Store the current audio features
    lastSpeakerRef.current = {
      ...lastSpeakerRef.current,
      features: features
    };
  };
  
  // Extract audio features for speaker identification
  const extractAudioFeatures = (dataArray) => {
    let sum = 0;
    let energy = 0;
    let lowFreqEnergy = 0;
    let highFreqEnergy = 0;
    
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
      energy += dataArray[i] * dataArray[i];
      
      // Split frequency bands
      if (i < dataArray.length / 2) {
        lowFreqEnergy += dataArray[i] * dataArray[i];
      } else {
        highFreqEnergy += dataArray[i] * dataArray[i];
      }
    }
    
    return {
      averageFrequency: sum / dataArray.length,
      energy: energy / dataArray.length,
      lowFreqEnergy: lowFreqEnergy / (dataArray.length / 2),
      highFreqEnergy: highFreqEnergy / (dataArray.length / 2),
      ratio: lowFreqEnergy / (highFreqEnergy || 1) // Avoid division by zero
    };
  };
  
  // Detect speaker changes based on audio features
  const detectSpeakerChange = (text) => {
    addLog(`Detecting speaker for: "${text}"`);
    
    // Clear any pending silence detection
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }
    
    const currentFeatures = lastSpeakerRef.current?.features;
    
    // Determine if this is a new speaker
    const isSpeakerChange = shouldChangeSpeaker(currentFeatures);
    let speakerId = lastSpeakerRef.current?.id || 1;
    
    if (isSpeakerChange) {
      addLog("Speaker change detected");
      
      // Try to identify the speaker or create a new one
      speakerId = identifySpeaker(currentFeatures) || currentSpeakerId;
      
      // Add a new transcript entry
      setTranscript(prev => [...prev, { id: speakerId, text }]);
      
      // Update last speaker
      lastSpeakerRef.current = {
        ...lastSpeakerRef.current,
        id: speakerId
      };
      
      // If this is a new speaker, update the counter
      if (speakerId === currentSpeakerId) {
        // Store this speaker's features
        speakerFeaturesRef.current[speakerId] = currentFeatures;
        setCurrentSpeakerId(prev => prev + 1);
      }
    } else {
      addLog("Continuing with the same speaker");
      
      // Continue with the same speaker
      setTranscript(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1].text += " " + text;
        } else {
          updated.push({ id: speakerId, text });
        }
        return updated;
      });
    }
    
    // Set silence detection timeout
    silenceTimeoutRef.current = setTimeout(() => {
      lastSpeakerRef.current = {
        ...lastSpeakerRef.current,
        id: null
      };
    }, 1500);
  };
  
  // Determine if we should change the speaker
  const shouldChangeSpeaker = (features) => {
    if (!lastSpeakerRef.current?.id) return true;
    if (!features) return false;
    
    const lastFeatures = lastSpeakerRef.current.features;
    if (!lastFeatures) return true;
    
    // Compare audio features
    const freqDiff = Math.abs(features.averageFrequency - lastFeatures.averageFrequency);
    const energyDiff = Math.abs(features.energy - lastFeatures.energy);
    const ratioDiff = Math.abs(features.ratio - lastFeatures.ratio);
    
    // Thresholds for speaker change detection
    return (freqDiff > 20) || (energyDiff > 1000) || (ratioDiff > 0.4);
  };
  
  // Try to identify if a speaker has been heard before
  const identifySpeaker = (features) => {
    if (!features) return null;
    
    let bestMatchId = null;
    let bestMatchScore = 0;
    
    // Compare with known speakers
    Object.entries(speakerFeaturesRef.current).forEach(([id, storedFeatures]) => {
      const freqDiff = Math.abs(features.averageFrequency - storedFeatures.averageFrequency);
      const energyDiff = Math.abs(features.energy - storedFeatures.energy);
      const ratioDiff = Math.abs(features.ratio - storedFeatures.ratio);
      
      // Calculate similarity score
      const similarityScore = 
        (freqDiff < 15 ? 1 : 0) + 
        (energyDiff < 800 ? 1 : 0) + 
        (ratioDiff < 0.3 ? 1 : 0);
      
      if (similarityScore > bestMatchScore) {
        bestMatchScore = similarityScore;
        bestMatchId = parseInt(id);
      }
    });
    
    // Need at least 2 matching features to identify a speaker
    return bestMatchScore >= 2 ? bestMatchId : null;
  };
  
  // Start recording with microphone
  const startRecording = async () => {
    try {
      addLog("Starting microphone recording");
      
      // Request microphone access
      const constraints = {
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        },
        video: false
      };
      
      addLog("Requesting microphone with constraints: " + JSON.stringify(constraints));
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      addLog("Microphone access granted");
      
      // Initialize transcript
      setTranscript([]);
      setCurrentSpeakerId(1);
      speakerFeaturesRef.current = {};
      lastSpeakerRef.current = null;
      setDebugLog([]);
      setError("");
      
      // Start streaming to Google Cloud Speech API
      startStreaming(stream);
      
    } catch (err) {
      addLog(`Error accessing microphone: ${err.message}`);
      setError(`Error accessing microphone: ${err.message}`);
    }
  };
  
  // Capture system audio
  const captureSystemAudio = async () => {
    try {
      addLog("Starting system audio capture");
      
      // Request display capture with audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      
      // Check if we have audio
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error("No audio track found. Make sure to select 'Share audio' when prompted.");
      }
      
      addLog("System audio capture successful");
      
      // Create a new stream with just the audio
      const audioStream = new MediaStream([audioTracks[0]]);
      
      // Initialize transcript
      setTranscript([]);
      setCurrentSpeakerId(1);
      speakerFeaturesRef.current = {};
      lastSpeakerRef.current = null;
      setDebugLog([]);
      setError("");
      
      // Start streaming
      startStreaming(audioStream);
      
    } catch (err) {
      addLog(`Error capturing system audio: ${err.message}`);
      setError(`Error capturing system audio: ${err.message}`);
    }
  };
  
  // Stop recording
  const stopRecording = () => {
    addLog("Stopping recording");
    
    // Close WebSocket connection
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    
    // Stop audio processing
    if (recognitionRef.current) {
      const { audioContext, source, recorder } = recognitionRef.current;
      
      if (recorder) {
        recorder.disconnect();
      }
      
      if (source) {
        source.disconnect();
      }
      
      if (audioContext) {
        // Don't close the AudioContext as it might be reused
        // Just suspend it
        audioContext.suspend();
      }
      
      recognitionRef.current = null;
    }
    
    // Stop all tracks in the stream
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => {
        track.stop();
        addLog(`Stopped track: ${track.kind}`);
      });
      micStreamRef.current = null;
    }
    
    // Clear silence detection timeout
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }
    
    setIsRecording(false);
    addLog("Recording stopped");
  };
  
  // Toggle recording state
  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };
  
  // Export transcript to file
  const exportTranscript = () => {
    if (transcript.length === 0) return;
    
    addLog("Exporting transcript");
    let content = "";
    transcript.forEach(entry => {
      content += `Speaker ${entry.id}: ${entry.text}\n\n`;
    });
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'meeting-transcript.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  // Clear error message
  const clearError = () => {
    setError("");
  };
  
  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);
  
  // Test API connection
  const testAPIConnection = async () => {
    try {
      addLog("Testing API connection");
      
      // Create a simple request to test the API key
      const url = `https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_API_KEY}`;
      const testRequest = {
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 16000,
          languageCode: "en-US",
        },
        audio: {
          content: "" // Empty audio content for testing
        }
      };
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(testRequest)
      });
      
      const data = await response.json();
      
      if (response.ok) {
        addLog("API connection successful");
        setError("API connection successful. You can now start recording.");
      } else {
        addLog(`API connection failed: ${JSON.stringify(data)}`);
        setError(`API connection failed: ${data.error?.message || 'Unknown error'}`);
      }
    } catch (err) {
      addLog(`Error testing API: ${err.message}`);
      setError(`Error testing API connection: ${err.message}`);
    }
  };
  
  return (
    <div className="flex flex-col p-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Meeting Transcription</h1>
      
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 flex justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="font-bold">×</button>
        </div>
      )}
      
      <div className="flex gap-4 mb-4">
        <button
          onClick={handleToggleRecording}
          className={`px-4 py-2 rounded font-bold ${
            isRecording ? "bg-red-500 text-white" : "bg-blue-500 text-white"
          }`}
        >
          {isRecording ? "Stop Recording" : "Start Recording (Microphone)"}
        </button>
        
        <button
          onClick={captureSystemAudio}
          className="px-4 py-2 rounded font-bold bg-green-500 text-white"
          disabled={isRecording}
        >
          Capture Meeting Audio
        </button>
        
        <button
          onClick={exportTranscript}
          className="px-4 py-2 rounded font-bold bg-purple-500 text-white"
          disabled={transcript.length === 0}
        >
          Export Transcript
        </button>
        
        <button
          onClick={testAPIConnection}
          className="px-4 py-2 rounded font-bold bg-yellow-500 text-white"
          disabled={isRecording}
        >
          Test API Connection
        </button>
      </div>
      
      <div className="border rounded p-4 bg-gray-50 min-h-64 max-h-96 overflow-y-auto">
        {transcript.length === 0 ? (
          <p className="text-gray-500">Transcription will appear here...</p>
        ) : (
          <div className="space-y-4">
            {transcript.map((entry, index) => (
              <div key={index} className="mb-2">
                <span className="font-bold text-blue-600">Speaker {entry.id}: </span>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      
      <div className="mt-4">
        <h2 className="font-bold mb-2">Debug Log</h2>
        <div className="border rounded p-4 bg-gray-50 text-xs font-mono h-32 overflow-y-auto">
          {debugLog.length === 0 ? (
            <p className="text-gray-500">Log messages will appear here...</p>
          ) : (
            <div>
              {debugLog.map((log, index) => (
                <div key={index} className="mb-1">
                  <span className="text-gray-500">[{log.time}]</span> {log.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      
      <div className="mt-4 text-sm text-gray-600">
        <p>
          Important: You must set a valid Google Cloud Speech-to-Text API key in the code.
          Replace "YOUR_GOOGLE_CLOUD_API_KEY" with your actual API key.
        </p>
        <p>
          Make sure to enable the Speech-to-Text API in your Google Cloud console and
          configure CORS to allow requests from your domain.
        </p>
      </div>
    </div>
  );
};

export default MeetingTranscription;