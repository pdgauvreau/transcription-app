import React, { useState, useEffect, useRef } from "react";

const MeetingTranscription = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState([]);
  const [currentSpeakerId, setCurrentSpeakerId] = useState(1);
  const [speakerMap, setSpeakerMap] = useState({});
  const [error, setError] = useState("");
  
  const microphoneRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const lastSpeakerRef = useRef(null);
  const silenceTimeoutRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  
  // Replace with your actual Google Cloud API key
  const GOOGLE_API_KEY = "fair-canto-453417-i3";
  
  // Initialize audio context
  useEffect(() => {
    const initAudio = async () => {
      try {
        // Create audio context
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContextRef.current = audioContext;
        
        // Setup audio analyser for voice activity detection
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
      } catch (err) {
        setError("Error initializing audio: " + err.message);
      }
    };
    
    initAudio();
    
    // Cleanup on unmount
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      stopRecording();
    };
  }, []);
  
  // Process audio data for Google Cloud Speech API
  const processAudioForGoogleSpeech = async (audioBlob) => {
    try {
      // Convert blob to base64
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      
      reader.onloadend = async () => {
        // Remove the "data:audio/webm;base64," part
        const base64Audio = reader.result.split(',')[1];
        
        // Prepare request to Google Cloud Speech-to-Text API
        const request = {
          config: {
            encoding: "WEBM_OPUS",
            sampleRateHertz: 48000,
            languageCode: "en-US",
            enableAutomaticPunctuation: true,
            enableWordTimeOffsets: true,
            model: "default",
            useEnhanced: true
          },
          audio: {
            content: base64Audio
          }
        };
        
        // Make request to Google Cloud Speech-to-Text API
        const response = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_API_KEY}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(request)
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`Google API error: ${errorData.error.message}`);
        }
        
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
          const transcript = data.results[0].alternatives[0].transcript;
          detectSpeakerChange(transcript);
        }
      };
    } catch (err) {
      setError("Error processing audio: " + err.message);
    }
  };
  
  // Start streaming microphone to Google Cloud Speech-to-Text API
  const startStreaming = async (stream) => {
    try {
      // Store the stream for later use
      streamRef.current = stream;
      
      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      
      // Reset audio chunks
      audioChunksRef.current = [];
      
      // Handle data available event
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      // Handle stop event
      mediaRecorder.onstop = () => {
        // Create blob from chunks
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];
        
        // Process audio with Google Cloud Speech-to-Text
        processAudioForGoogleSpeech(audioBlob);
        
        // Start a new recording if still recording
        if (isRecording) {
          mediaRecorderRef.current.start(5000); // Record in 5-second chunks
        }
      };
      
      // Start recording
      mediaRecorder.start(5000); // Record in 5-second chunks
    } catch (err) {
      setError("Error starting stream: " + err.message);
    }
  };
  
  // Start recording with microphone
  const startRecording = async () => {
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000
        },
        video: false
      });
      
      // Connect microphone to audio context for speaker identification
      const microphoneSource = audioContextRef.current.createMediaStreamSource(stream);
      microphoneSource.connect(analyserRef.current);
      
      // Create script processor for audio analysis
      const bufferSize = 4096;
      const processor = audioContextRef.current.createScriptProcessor(bufferSize, 1, 1);
      processor.onaudioprocess = processAudioForSpeakerDetection;
      
      // Connect the processor
      analyserRef.current.connect(processor);
      processor.connect(audioContextRef.current.destination);
      
      // Store references
      microphoneRef.current = {
        stream,
        source: microphoneSource,
        processor
      };
      
      // Start streaming to Google Cloud Speech-to-Text
      startStreaming(stream);
      
      // Reset the transcription with the first speaker
      setTranscript([]);
      setCurrentSpeakerId(1);
      setSpeakerMap({});
      setIsRecording(true);
      
    } catch (err) {
      setError("Error accessing microphone: " + err.message);
    }
  };
  
  // Audio processing callback for speaker detection
  const processAudioForSpeakerDetection = (e) => {
    // Get audio features for speaker detection
    if (analyserRef.current) {
      const bufferLength = analyserRef.current.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyserRef.current.getByteFrequencyData(dataArray);
      
      // Store audio features for speaker identification
      const audioFeatures = getAudioFeatures(dataArray);
      lastSpeakerRef.current = {
        ...lastSpeakerRef.current,
        features: audioFeatures
      };
    }
  };
  
  // Stop recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    
    if (microphoneRef.current) {
      // Disconnect and stop all audio processing
      microphoneRef.current.source.disconnect();
      if (microphoneRef.current.processor) {
        microphoneRef.current.processor.disconnect();
      }
      
      // Stop all tracks in the stream
      microphoneRef.current.stream.getTracks().forEach(track => track.stop());
      
      // Clear the reference
      microphoneRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    setIsRecording(false);
  };
  
  // Toggle recording state
  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };
  
  // Capture system audio for meetings
  const captureSystemAudio = async () => {
    try {
      // Request display capture with audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      
      // Check if we have audio tracks
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error("No audio track found in screen capture. Make sure to select 'Share audio' when prompted.");
      }
      
      // Create a new stream with just the audio track
      const audioStream = new MediaStream([audioTracks[0]]);
      
      // Connect to audio context for speaker identification
      const source = audioContextRef.current.createMediaStreamSource(audioStream);
      source.connect(analyserRef.current);
      
      // Create script processor for audio analysis
      const bufferSize = 4096;
      const processor = audioContextRef.current.createScriptProcessor(bufferSize, 1, 1);
      processor.onaudioprocess = processAudioForSpeakerDetection;
      
      // Connect the processor
      analyserRef.current.connect(processor);
      processor.connect(audioContextRef.current.destination);
      
      // Store references
      microphoneRef.current = {
        stream: audioStream,
        source,
        processor,
        displayStream: stream // Keep reference to stop it later
      };
      
      // Start streaming to Google Cloud Speech-to-Text
      startStreaming(audioStream);
      
      // Reset the transcription with the first speaker
      setTranscript([]);
      setCurrentSpeakerId(1);
      setSpeakerMap({});
      setIsRecording(true);
      
    } catch (err) {
      setError("Error capturing system audio: " + err.message);
    }
  };
  
  // Detect speaker changes based on silence and audio characteristics
  const detectSpeakerChange = (text) => {
    if (!text || text.trim() === "") return;
    
    // Clear any pending silence detection
    if (silenceTimeoutRef.current) {
      clearTimeout(silenceTimeoutRef.current);
    }
    
    const audioFeatures = lastSpeakerRef.current?.features;
    
    // Simple algorithm: if silence for more than 1.5s or significant change in audio features
    const shouldChangeSpeaker = 
      !lastSpeakerRef.current?.id || 
      (audioFeatures && audioFeaturesDifferSignificantly(audioFeatures));
    
    if (shouldChangeSpeaker) {
      // Determine if this is a new speaker or a returning one
      const speakerId = identifySpeaker(audioFeatures) || currentSpeakerId;
      
      // Add a new entry for a new speaker
      setTranscript(prev => [...prev, { id: speakerId, text: text.trim() }]);
      
      // Update last speaker reference
      lastSpeakerRef.current = {
        ...lastSpeakerRef.current,
        id: speakerId
      };
      
      // If this is a truly new speaker, increment the counter
      if (!Object.values(speakerMap).includes(speakerId)) {
        setCurrentSpeakerId(prev => prev + 1);
      }
    } else {
      // Continue with the same speaker
      setTranscript(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1].text += " " + text.trim();
        } else {
          updated.push({ id: lastSpeakerRef.current?.id || currentSpeakerId, text: text.trim() });
        }
        return updated;
      });
    }
    
    // Set timeout to detect silence between speakers
    silenceTimeoutRef.current = setTimeout(() => {
      lastSpeakerRef.current = {
        ...lastSpeakerRef.current,
        id: null
      };
    }, 1500);
  };
  
  // Get audio features for speaker identification
  const getAudioFeatures = (dataArray) => {
    if (!dataArray) return null;
    
    // Calculate simple features: average frequency and energy
    let sum = 0;
    let energy = 0;
    let lowFreqEnergy = 0;
    let highFreqEnergy = 0;
    
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
      energy += dataArray[i] * dataArray[i];
      
      // Split frequency spectrum for better fingerprinting
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
      ratio: lowFreqEnergy / (highFreqEnergy || 1) // Prevent division by zero
    };
  };
  
  // Compare audio features to detect significant changes
  const audioFeaturesDifferSignificantly = (features) => {
    if (!lastSpeakerRef.current?.features) return true;
    
    const lastFeatures = lastSpeakerRef.current.features;
    const freqDiff = Math.abs(features.averageFrequency - lastFeatures.averageFrequency);
    const energyDiff = Math.abs(features.energy - lastFeatures.energy);
    const ratioDiff = Math.abs(features.ratio - lastFeatures.ratio);
    
    // Weighted comparison for better detection
    return (freqDiff > 20) || (energyDiff > 1000) || (ratioDiff > 0.3);
  };
  
  // Identify if a speaker has been heard before
  const identifySpeaker = (features) => {
    if (!features) return null;
    
    // Check if these features match any previous speaker
    for (const [speakerId, speakerFeatures] of Object.entries(speakerMap)) {
      const freqDiff = Math.abs(features.averageFrequency - speakerFeatures.averageFrequency);
      const energyDiff = Math.abs(features.energy - speakerFeatures.energy);
      const ratioDiff = Math.abs(features.ratio - speakerFeatures.ratio);
      
      // Weight different features for better identification
      const similarityScore = 
        (freqDiff < 15 ? 1 : 0) + 
        (energyDiff < 800 ? 1 : 0) + 
        (ratioDiff < 0.2 ? 1 : 0);
      
      if (similarityScore >= 2) {
        return parseInt(speakerId);
      }
    }
    
    // If no match, add to speaker map
    setSpeakerMap(prev => ({
      ...prev,
      [currentSpeakerId]: features
    }));
    
    return null;
  };
  
  // Export transcript to text file
  const exportTranscript = () => {
    if (transcript.length === 0) return;
    
    let content = "";
    transcript.forEach(entry => {
      if (entry.text) {
        content += `Speaker ${entry.id}: ${entry.text}\n\n`;
      }
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
  
  return (
    <div className="flex flex-col p-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Meeting Transcription</h1>
      
      {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}
      
      <div className="flex gap-4 mb-4">
        <button
          onClick={handleToggleRecording}
          className={`px-4 py-2 rounded font-bold ${isRecording ? 'bg-red-500 text-white' : 'bg-blue-500 text-white'}`}
        >
          {isRecording ? 'Stop Recording' : 'Start Recording (Microphone)'}
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
      
      <div className="mt-4 text-sm text-gray-600">
        <p>Note: For system audio capture, you need a virtual audio cable like VB-Audio VoiceMeeter to route system audio to the browser.</p>
      </div>
    </div>
  );
};

export default MeetingTranscription;