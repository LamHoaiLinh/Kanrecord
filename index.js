// ------------------------------------------------------------------------
// Scrawl-canvas boilerplate
// ------------------------------------------------------------------------
import * as scrawl from './js/scrawl.js';
const name = (n) => `canvas-${n}`;
const canvas = scrawl.findCanvas('my-canvas');


// ------------------------------------------------------------------------
// MediaPipe and client-zip imports
// ------------------------------------------------------------------------
import * as MediaPipe from './js/mediapipe-vision-bundle.js';
import { downloadZip } from './js/client-zip.js';


// ------------------------------------------------------------------------
// Camera and Audio device discovery
// ------------------------------------------------------------------------
const DeviceManager = {

  // Device data
  microphones: [],
  cameras: [],
  permissionGranted: false,
  onChangeCallbacks: [],

  // User selection history
  preferredMicrophone: 'none',
  preferredCamera: 'none',

  // Subscribe listeners (UI rebuilds, etc.)
  onChange(fn) {

    if (typeof fn === 'function') this.onChangeCallbacks.push(fn);
  },

  // Trigger callbacks
  triggerChange() {

    const payload = {
      microphones: this.microphones,
      cameras: this.cameras,
      permissionGranted: this.permissionGranted,
    };
    this.onChangeCallbacks.forEach(fn => fn(payload));
  },

  // Permissions are requested only when the user actually enables a camera
  // or starts recording with a microphone. Opening Kanrecode should stay quiet.
  ensurePermission() {
    return Promise.resolve('permission-on-demand');
  },

  // Discover devices without forcing a camera/microphone permission prompt.
  refreshDevices() {
    return navigator.mediaDevices.enumerateDevices()
      .then(devices => {
        this.microphones = devices
          .filter(d => d.kind === 'audioinput')
          .map((d, index) => ({
            id: d.deviceId,
            label: d.label || `Microphone ${index + 1}`,
          }));

        this.cameras = devices
          .filter(d => d.kind === 'videoinput')
          .map((d, index) => ({
            id: d.deviceId,
            label: d.label || `Camera ${index + 1}`,
          }));

        this.triggerChange();
        return 'refreshed';
      })
      .catch(err => {
        console.warn('Device enumeration failed:', err);
        this.triggerChange();
        return 'device-enumeration-failed';
      });
  }
};

// Hot-plug support
navigator.mediaDevices.addEventListener(
  'devicechange',
  () => DeviceManager.refreshDevices()
);

// Teleprompter state
let teleprompterIsVisible = false;
let teleprompterIsRunning = false;

// Kanrecode runtime state
// Keep references to captured display streams so their optional audio tracks can
// be mixed into the final recording when the browser/user shares audio.
const capturedTargetStreams = new Map();

const setAppStatus = (text, mode = 'ready') => {
  const pill = document.getElementById('status-pill');
  if (!pill) return;
  pill.textContent = text;
  pill.dataset.mode = mode;
};


const captureTargetMeta = new Map();

const GuideState = {
  activeTargetName: null,
  pointer: { x: 0.5, y: 0.5 },
  lastClickAt: 0,
  cropOpen: false,
};

const DesktopBridge = {
  available: false,
  windowsHooks: false,
  recordingsDir: '',
  recovery: [],
  lastEventId: 0,
  eventTimer: null,
  listeners: new Set(),

  onEvent(fn) {
    if (typeof fn === 'function') this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  emit(event) {
    this.listeners.forEach(fn => {
      try { fn(event); }
      catch (err) { console.warn('Desktop helper event handler failed:', err); }
    });
  },

  async request(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof Blob) ? {'Content-Type': 'application/json'} : {}),
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },

  async init() {
    const status = document.getElementById('desktop-helper-status');
    const openFolder = document.getElementById('open-recordings-button');
    const directDisk = document.getElementById('recording-direct-disk');
    const directSaveStatus = document.getElementById('direct-save-status');
    const recoveryBanner = document.getElementById('recovery-banner');

    try {
      const info = await this.request('/api/health');
      this.available = !!info.helper;
      this.windowsHooks = !!info.windowsHooks;
      this.recordingsDir = info.recordingsDir || '';
      this.recovery = Array.isArray(info.recovery) ? info.recovery : [];

      if (status) {
        status.textContent = this.windowsHooks
          ? 'Desktop Helper: ON · phím/chuột toàn Windows'
          : 'Desktop Helper: ON · không có Windows hook';
        status.classList.add('is-online');
        status.title = this.recordingsDir ? `Video dài: ${this.recordingsDir}` : '';
      }
      if (openFolder) openFolder.hidden = false;
      if (directDisk) {
        directDisk.disabled = false;
        directDisk.checked = true;
      }
      if (directSaveStatus && this.recordingsDir) {
        directSaveStatus.innerHTML = `Video dài sẽ ghi trực tiếp vào <b>${this.recordingsDir}</b>, không giữ toàn bộ video trong RAM.`;
      }
      if (recoveryBanner && this.recovery.length) {
        recoveryBanner.hidden = false;
        recoveryBanner.textContent = `Phát hiện ${this.recovery.length} tệp .partial từ phiên quay chưa hoàn tất. Bấm “Video” để mở thư mục.`;
      }

      this.startPolling();
      return true;
    }
    catch (err) {
      this.available = false;
      if (status) {
        status.textContent = 'Desktop Helper: OFF · phím/click chỉ hoạt động trong Kanrecode';
        status.classList.add('is-offline');
      }
      if (directDisk) {
        directDisk.checked = false;
        directDisk.disabled = true;
      }
      if (directSaveStatus) {
        directSaveStatus.textContent = 'Desktop Helper chưa chạy: video sẽ được giữ trong bộ nhớ trình duyệt và tải xuống khi dừng quay.';
      }
      return false;
    }
  },

  startPolling() {
    if (!this.available || this.eventTimer) return;

    const poll = async () => {
      if (!this.available) return;
      try {
        const data = await this.request(`/api/events?since=${this.lastEventId}`);
        const events = Array.isArray(data.events) ? data.events : [];
        events.forEach(event => this.emit(event));
        this.lastEventId = Number(data.lastId || this.lastEventId);
      }
      catch (err) {
        console.warn('Desktop Helper polling paused:', err);
      }
      this.eventTimer = setTimeout(poll, 65);
    };
    poll();
  },

  async syncState(state) {
    if (!this.available) return;
    try {
      await this.request('/api/state', {
        method: 'POST',
        body: JSON.stringify(state),
      });
    }
    catch (err) {
      console.warn('Cannot sync Desktop Helper state:', err);
    }
  },

  async openRecordingsFolder() {
    if (!this.available) return;
    await this.request('/api/open-recordings', { method: 'POST', body: '{}' });
  },

  async startRecordingFile(filename, extension) {
    if (!this.available) return null;
    const data = await this.request('/api/recording/start', {
      method: 'POST',
      body: JSON.stringify({ filename, extension }),
    });
    return data.ok ? data : null;
  },

  async writeRecordingChunk(id, blob) {
    if (!this.available || !id || !blob?.size) return;
    const response = await fetch(`/api/recording/chunk?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      cache: 'no-store',
      body: blob,
    });
    if (!response.ok) throw new Error(`Chunk write failed: HTTP ${response.status}`);
    return response.json();
  },

  async finishRecordingFile(id) {
    if (!this.available || !id) return null;
    return this.request('/api/recording/finish', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  },
};


// ------------------------------------------------------------------------
// Modal management
// ------------------------------------------------------------------------
let currentModal;

const openModal = (modal, fn = null) => {

  if (currentModal) closeModal();

  if (fn) fn();

  // Needs to be in a timeout because the keypress itself will launch a modal close event
  setTimeout(() => {

    if (!currentModal) {

      modal.showModal();
      currentModal = modal;
    }
  }, 100);
};

const closeModal = () => {

  const m = currentModal;
  currentModal = null;

  if (m) m.close();
};


// ------------------------------------------------------------------------
// Dimensions management modal
// - Defines 9 video output options, with the help of some magic numbers
// ------------------------------------------------------------------------
let currentDimension = 'landscape_720';

const initDimensions = () => {

  // Initialize DOM dimensions button and associated modal
  dimensionsButton.removeAttribute('disabled');
  scrawl.addNativeListener('click', () => openModal(dimensionsModal), dimensionsButton);
  scrawl.addNativeListener('click', closeModal, dimensionsCloseButton);
  scrawl.addNativeListener('close', closeModal, dimensionsModal);

  // We display the currently selected dimensions in the bottom right of the page
  currentCanvasDimensions.textContent = '1280 × 720 px';

  // Define the supported video dimensions
  // - Eack key has an array of three numbers representing [width, height, scaler]
  const magicDimensions = {

    landscape_1080: [1920, 1080, 1080],
    landscape_720: [1280, 720, 720],
    landscape_480: [854, 480, 480],
    square_1080: [1080, 1080, 1080],
    square_720: [720, 720, 720],
    square_480: [480, 480, 480],
    portrait_1080: [1080, 1920, 1080],
    portrait_720: [720, 1280, 720],
    portrait_480: [480, 854, 480],
  };

  // Some helper functions
  const getDimensions = (dim) => {

    const [width, height] = magicDimensions[dim];
    return [width, height];
  };

  const getScaler = (dim) => {

    return magicDimensions[dim][2];
  };

  // The main dimensions update function
  const update = () => {

    const newDimension = dimensionsSelector.value;

    if (newDimension !== currentDimension) {

      canvas.setBase({ dimensions: getDimensions(newDimension) });

      updateTargetScales(getScaler(currentDimension), getScaler(newDimension));

      currentDimension = newDimension;

      updateBackgroundPicture();

      const [w, h] = getDimensions(currentDimension);

      currentCanvasDimensions.textContent = `${w} × ${h} px`;

      // If a target is being edited, the scale edit control needs updating
      // - Has to be done in a timeout as SC entity updates are batched to requestAnimationFrame calls
      const editInProgress = updateGroup.get('artefacts');
      if (editInProgress.length) {

        const ent = scrawl.findEntity(editInProgress[0]);
        if (ent) setTimeout(() => entityScale.value = `${ent.get('scale')}`, 50);
      }

      updateAllScribbles();
      updateLogoPosition();
    }
  };

  // Add the update function to the modal's dimensionsSelector element
  scrawl.addNativeListener('change', update, dimensionsSelector);

  return { 
    getDimensions,
    getScaler,
  };
};


// ------------------------------------------------------------------------
// Instructions modal
// - Offers users instructions for using the tool
// ------------------------------------------------------------------------
const initInstructions = () => {

  // Initialize DOM instructions button and associated modal
  scrawl.addNativeListener('click', () => openModal(instructionsModal), instructionsButton);
  scrawl.addNativeListener('click', closeModal, instructionsCloseButton);
  scrawl.addNativeListener('close', closeModal, instructionsModal);

  return {};
};


// ------------------------------------------------------------------------
// Teleprompter functionality
// ------------------------------------------------------------------------
const initTeleprompter = () => {

  // Initialize DOM teleprompter edit button and associated modal
  scrawl.addNativeListener('click', () => openTelepromptModal(), telepromptButton);
  scrawl.addNativeListener('click', closeModal, telepromptCloseButton);
  scrawl.addNativeListener('close', closeModal, telepromptModal);

  // Local state variables management
  let telepromptIndex = -1;  

  const telepromptLines = [],
    telepromptTimestamps = [],
    initialReadingText = 'Nhấn Space để chuyển lời thoại',
    initialStageText = 'Ghi chú sẽ hiện ở đây',
    endOfFileText = '[Hết lời thoại]';

  telepromptReading.textContent = initialReadingText;
  telepromptStage.textContent = initialStageText;

  const resetTelepromptRuntime = () => {

    telepromptLines.length = 0;
    telepromptIndex = -1;
    telepromptTimestamps.length = 0;

    telepromptReading.textContent = initialReadingText;
    telepromptStage.textContent = initialStageText;
  };


  // Setup teleprompter reveal/hide functionality
  const toggleTeleprompterArea = () => {

    if (teleprompterIsRunning) return;

    teleprompterIsVisible = !teleprompterIsVisible;

    if (teleprompterIsVisible) {

      appPanel.classList.add('teleprompter-active');
      telepromptAreaButton.textContent = '× Ẩn Teleprompter';
    }
    else {

      appPanel.classList.remove('teleprompter-active');
      telepromptAreaButton.textContent = '▤ Teleprompter';
    }
  };
  scrawl.addNativeListener('click', toggleTeleprompterArea, telepromptAreaButton);

  // Specific instructions when opening the teleprompter modal
  const openTelepromptModal = () => {

    openModal(telepromptModal);
    setTimeout(() => telepromptEditor.focus(), 120);
  };

  // Build state from teleprompt editor contents
  const parseTelepromptScript = () => {

    const raw = telepromptEditor.value.trim();

    if (!raw) return [];

    return raw
      .split(/\n/)
      .map(t => t.trim())
      .filter(t => t.length)
      .filter(t => !t.startsWith('/'))
      .map(text => {

        if (text.startsWith('~')) {
          return {
            type: 'stage',
            text: text.slice(1).trim(),
          };
        }

        return {
          type: 'read',
          text,
        };
      });
  };

  // Buttons that should be disabled during test runs
  const teleprompterLockedButtons = [
    telepromptButton,
    recordingButton,
    telepromptAreaButton,
    dimensionsButton,
  ];

  const disableTeleprompterButtons = () => {

    teleprompterLockedButtons.forEach(btn => btn.setAttribute('disabled', ''));
  };

  const enableTeleprompterButtons = () => {

    teleprompterLockedButtons.forEach(btn => btn.removeAttribute('disabled'));
  };

  scrawl.addNativeListener('click', () => {

    if (!teleprompterIsRunning) startTeleprompterTest();
    else stopTeleprompterTest();

  }, telepromptTestButton);

  const displayNextTelepromptLine = () => {

    telepromptIndex++;

    if (telepromptIndex >= telepromptLines.length) {

      telepromptStage.textContent = '';
      telepromptReading.textContent = endOfFileText;
      return;
    }

    const line = telepromptLines[telepromptIndex];

    if (line.type === 'stage') {
      telepromptStage.textContent = line.text;
    }
    else {
      telepromptReading.textContent = line.text;

      telepromptTimestamps.push({
        text: line.text,
        time: recordingTimer.textContent,
      });
    }
  };

  const populateTelepromptState = () => {

    resetTelepromptRuntime();
    telepromptLines.push(...parseTelepromptScript());
  };

  const startTeleprompterTest = () => {

    populateTelepromptState();

    if (!telepromptLines.length) return;

    teleprompterIsRunning = true;

    closeModal();
    disableTeleprompterButtons();

    telepromptTestButton.textContent = 'Stop test';
    telepromptTestButton.classList.add('teleprompter-test-running');

    startRecordingTimer();
  };

  const stopTeleprompterTest = () => {

    teleprompterIsRunning = false;

    stopRecordingTimer();

    enableTeleprompterButtons();

    telepromptTestButton.textContent = 'Run test';
    telepromptTestButton.classList.remove('teleprompter-test-running');
  };

  scrawl.addNativeListener('keydown', (e) => {

    if (e.code !== 'Space') return;
    if (!teleprompterIsVisible) return;
    if (!teleprompterIsRunning) return;

    e.preventDefault();

    displayNextTelepromptLine();

  }, document);

  const telepromptHasScript = () => telepromptLines.length > 0;

  return {
    telepromptTimestamps,
    displayNextTelepromptLine,
    populateTelepromptState,
    telepromptHasScript,
  };
};


// ------------------------------------------------------------------------
// Head management controls
// - generates a talking head - with the help of a Google MediaPipe solution
// - https://ai.google.dev/edge/mediapipe/solutions/guide
// ------------------------------------------------------------------------
const initTalkingHead = () => {

  // Camera discovery
  DeviceManager.onChange(({ cameras }) => {

    const frag = document.createDocumentFragment();
    const none = document.createElement('option');
    none.value = 'none';
    none.textContent = 'Không dùng camera';
    frag.appendChild(none);

    cameras.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.id;
      opt.textContent = cam.label;
      frag.appendChild(opt);
    });

    headCamera.replaceChildren(...frag.querySelectorAll('option'));
    setTimeout(() => headCamera.value = DeviceManager.preferredCamera || 'none');
  });

  // Initialize DOM head button and associated modal
  scrawl.addNativeListener('change', () => DeviceManager.preferredCamera = headCamera.value, headCamera);

  // Google MediaPipe ML model code
  let imageSegmenter,
    modelIsRunning = false;

  const startModel = async () => {

    const upstream = 'https://cdn.jsdelivr.net/gh/KaliedaRik/sc-screen-recorder@main/js/mediapipe';
    const vision = await MediaPipe.FilesetResolver.forVisionTasks(`${upstream}/wasm`);

    imageSegmenter = await MediaPipe.ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${upstream}/model/selfie_segmenter.tflite`,
      },
      outputCategoryMask: true,
      outputConfidenceMasks: false,
      runningMode: 'LIVE_STREAM',
    });

    modelIsRunning = true;
  };

  // We can start the model code running straight away
  // - It's the camera for which we need user permission
  startModel().catch(err => {
    console.warn('MediaPipe background removal unavailable:', err);
    setAppStatus('Sẵn sàng · xóa nền camera chưa tải được', 'warning');
  });

  // Set up some hidden Cells to process the camera data and create the desired output
  // - This first Cell receives the camera data
  const talkingHeadFrame = canvas.buildCell({

    name: name('talking-head-frame'),
    dimensions: [768, 768],
    cleared: false,
    compiled: false,
    shown: false,
  });

  // We use this Cell to feed data into MediaPipe
  const talkingHeadInput = canvas.buildCell({

    name: name('talking-head-input'),
    dimensions: [256, 256],
    shown: false,
  });

  // We also need a Cell where we can composite the final head image output
  const talkingHeadOutput = canvas.buildCell({

    name: name('talking-head-output'),
    dimensions: [768, 768],
    shown: false,
  });

  // We process the model's output in a dedicated mask Cell
  // - We do this using direct manipulation of the Cell's image data
  const talkingHeadMask = canvas.buildCell({

    name: name('talking-head-mask'),
    dimensions: [256, 256],
    cleared: false,
    compiled: false,
    shown: false,
  });

  const maskData = talkingHeadMask.getCellData(true),
    pixels = maskData.pixelState;

  // This function gets consumed by the model's imageSegmenter object
  // - imageSegmenter doesn't start its work until it has something to segment
  const processModelData = (results) => {

    // Magic numbers warning
    const threshold = 32,
      softness = 32;

    let inv, alpha;

    const data = results.categoryMask.containers[0];

    if (data && data.length) {

      data.forEach((val, index) => {

        inv = 255 - val;

        if (inv <= threshold) alpha = 0;
        else if (inv >= threshold + softness) alpha = 255;
        else alpha = ((inv - threshold) / softness) * 255;

        pixels[index].alpha = alpha;
      });

      talkingHeadMask.paintCellData(maskData);

      talkingHeadFrame.clear();
      talkingHeadFrame.compile();
    }
  };

  // The framePicture's asset will be the camera feed, in due course
  const framePicture = scrawl.makePicture({

    name: name('talking-head-frame-picture'),
    group: talkingHeadFrame,
    copyDimensions: ['100%', '100%'],
    start: ['center', 'center'],
    handle: ['center', 'center'],
  });

  scrawl.makePicture({

    name: name('talking-head-input-picture'),
    group: talkingHeadInput,
    asset: talkingHeadFrame,
    dimensions: ['100%', '100%'],
    copyDimensions: ['100%', '100%'],
  });

  const rectShape = scrawl.makeRectangle({

    name: name('talking-head-rectangle'),
    group: talkingHeadOutput,
    start: ['center', 'center'],
    handle: ['center', 'center'],
    rectangleWidth: '100%',
    rectangleHeight: '100%',
    radius: '15%',
  })

  scrawl.makeFilter({

    name: name('mask-blur'),
    method: 'gaussianBlur',
    radius: 1.5,
  })

  const maskPicture = scrawl.makePicture({

    name: name('talking-head-mask-picture'),
    group: talkingHeadOutput,
    asset: talkingHeadMask,
    dimensions: ['100%', '100%'],
    copyDimensions: ['100%', '100%'],
    filters: [name('mask-blur')],
    globalCompositeOperation: 'source-in',
  });

  scrawl.makePicture({

    name: name('talking-head-overlay-picture'),
    group: talkingHeadOutput,
    asset: talkingHeadFrame,
    dimensions: ['100%', '100%'],
    copyDimensions: ['100%', '100%'],
    globalCompositeOperation: 'source-in',
    order: 1,
  });

  // Finally we can grab the composited output and display it on the main canvas
  let headIsDisplayed;

  const outputPicture = scrawl.makePicture({

    name: name('talking-head-output-picture'),
    asset: talkingHeadOutput,
    dimensions: [768, 768],
    copyDimensions: ['100%', '100%'],

    order: 200,

    start: ['75%', '75%'],
    handle: ['center', 'center'],

    flipReverse: true,
    scale: 0.5,

    method: 'fill',

    visibility: false,
  });

  // Capture the device camera output
  // - But only after the user agrees
  let mycamera,
    myCameraAnimation;

  const startCamera = () => {

    if (DeviceManager.preferredCamera === 'none') {
      headUseCheckbox.checked = false;
      setAppStatus('Hãy chọn camera trước', 'warning');
      return;
    }

    scrawl.importMediaStream({

      name: name('camera-feed'),
      audio: false,
      video: {
        width: { ideal: 768 },
        height: { ideal: 768 },
        deviceId: DeviceManager.preferredCamera,
      },
      onMediaStreamEnd: () => stopCamera(),

    }).then(res => {

      mycamera = res;
      DeviceManager.refreshDevices();
      setAppStatus('Camera đã bật', 'ready');

      // We asked for a 768 x 768 media stream, but the browser won't guarantee returning those dimensions
      // - Thus we need to adapt the picture elements to accommodate vaiations
      scrawl.addNativeListener('loadedmetadata', () => {

        const width = mycamera.source.videoWidth,
          height = mycamera.source.videoHeight,
          minimumDimension = Math.min(width, height),
          scale = 768 / minimumDimension;

        framePicture.set({
          dimensions: [width, height],
          scale,
          asset: mycamera, 
        }, mycamera.source);

        talkingHeadFrame.clear();
        talkingHeadFrame.compile();

        outputPicture.set ({ visibility: true });

        headShowCheckbox.removeAttribute('disabled');

        // We need to feed input data into the model discretely, via an SC animation object
        myCameraAnimation = scrawl.makeAnimation({

          name: name('head-segmenter'),
          order: 0,
          fn: () => {

            if (imageSegmenter && imageSegmenter.segmentForVideo) {

              imageSegmenter.segmentForVideo(talkingHeadInput.element, performance.now(), processModelData);
            }
          }
        });
      }, mycamera.source);

    }).catch(err => console.log(err.message));
  };

  // Kill the camera media stream and all associated SC objects
  const stopCamera = () => {

    headShowCheckbox.setAttribute('disabled', '');
    if (!mycamera) return;

    if (mycamera.source) mycamera.source.srcObject = null;
    if (mycamera.mediaStreamTrack != null) mycamera.mediaStreamTrack.stop();
    if (mycamera.mediaStream) mycamera.mediaStream.getTracks().forEach(track => track.stop());
    if (myCameraAnimation) myCameraAnimation.kill();

    framePicture.set({ asset: '' });
    outputPicture.set({ visibility: false });

    mycamera.kill();
    mycamera = null;
    myCameraAnimation = null;
    setAppStatus('Camera đã tắt');
  };

  // Displaying and removing the talking head
  // - Option only appears after a camera media stream capture starts
  const toggleHead = (toggle) => {

    if (modelIsRunning) {

      if (toggle && !headIsDisplayed) {

        startCamera();

        headHorizontal.removeAttribute('disabled');
        headVertical.removeAttribute('disabled');
        headScale.removeAttribute('disabled');
        headOpacity.removeAttribute('disabled');
        headRotation.removeAttribute('disabled');
        headShape.removeAttribute('disabled');

        headIsDisplayed = true;
      }
      else if (!toggle && headIsDisplayed) {

        stopCamera();

        headHorizontal.setAttribute('disabled', '');
        headVertical.setAttribute('disabled', '');
        headScale.setAttribute('disabled', '');
        headOpacity.setAttribute('disabled', '');
        headRotation.setAttribute('disabled', '');
        headShape.setAttribute('disabled', '');

        headIsDisplayed = false;
      }
    }
    else {

      if (headIsDisplayed) stopCamera();

      headHorizontal.setAttribute('disabled', '');
      headVertical.setAttribute('disabled', '');
      headScale.setAttribute('disabled', '');
      headOpacity.setAttribute('disabled', '');
      headRotation.setAttribute('disabled', '');
      headShape.setAttribute('disabled', '');

      headIsDisplayed = false;
    }
  }

  // More event listeners for the 'head' modal's user interaction
  // ... 'Use talking head' checkbox (keyboard: SPACE)
  scrawl.addNativeListener('change', () => {

    if (headUseCheckbox.checked) toggleHead(true);
    else toggleHead(false);

  }, headUseCheckbox);

  // ... 'Show talking head' checkbox (keyboard: SPACE)
  scrawl.addNativeListener('change', () => {

    if (myCameraAnimation) {

      if (headShowCheckbox.checked && !headIsDisplayed) {

        outputPicture.set ({ visibility: true });
        headIsDisplayed = true;
      }
      else if (!headShowCheckbox.checked && headIsDisplayed) {

        outputPicture.set ({ visibility: false });
        headIsDisplayed = false;
      }
    }
  }, headShowCheckbox);

  // All the other talking head parameters (which are ranges, thus keyboard: ARROW keys)
  scrawl.makeUpdater({

    event: ['input', 'change'],
    origin: '.head-controls',

    target: outputPicture,

    useNativeListener: true,
    preventDefault: true,

    updates: {
      ['head-horizontal']: ['startX', '%'],
      ['head-vertical']: ['startY', '%'],
      ['head-scale']: ['scale', 'float'],
      ['head-opacity']: ['globalAlpha', 'float'],
      ['head-rotation']: ['roll', 'float'],
    },
  });

  // Change the corner radius of the background behind the head
  scrawl.addNativeListener(['input', 'change'], () => {

    const radius = headShape.value;
    rectShape.set({ radius: `${radius}%` });

  }, headShape);

  // Show or remove the head background (keyboard: ARROWS, RETURN)
  scrawl.addNativeListener('change', () => {

    maskPicture.set({ visibility: headBackground.value === '1' ? true : false });

  }, headBackground);

  // Filter effects on the head (keyboard: ARROWS, RETURN)
  scrawl.addNativeListener('change', () => {

    talkingHeadOutput.set({ filters: [headFilter.value] });

  }, headFilter);
};


// ------------------------------------------------------------------------
// Targets management controls
// ------------------------------------------------------------------------
const initTargets = () => {

  // Initialize DOM targets button and associated modal
  scrawl.addNativeListener('click', () => requestScreenCapture(), targetRequestButton);

  // Local state
  let targetCount = 0;
  const targetsPictureArray = [],
    targetNamesObject = {};

  // The main request screen capture function
  // - Users can add multiple screen-captured targets to the canvas
  const requestScreenCapture = () => {

    const targetId = name(`target-${targetCount}`);
    targetCount++;

    targetNamesObject[targetId] = targetId;

    // Screen capture streams are brittle
    // - We need to remove associated assets and entitys from SC when they fail us
    // - TODO: not yet implemented
    let cleanup = () => console.log(`${targetId} - video track stream has ended`);

    // The main event!
    // - Gets the user's desired media stream (via browser functionality)
    // - Creates an SC asset (including a hidden video element) and Picture entity from it
    scrawl.importScreenCapture({

      name: targetId,

      // Is this the line causing audio issues?
      audio: { suppressLocalAudioPlayback: true },

      onMediaStreamEnd: () => cleanup(),

    }).then(mycamera => {

      if (mycamera.mediaStream) capturedTargetStreams.set(targetId, mycamera.mediaStream);
      setAppStatus('Đã thêm nguồn màn hình', 'ready');

      // Create a Picture entity to display the media stream on the canvas
      const targetPicture = scrawl.makePicture({

        name: targetId,
        asset: mycamera.name,

        dimensions: [1, 1],
        copyDimensions: ['100%', '100%'],

        start: ['50%', '50%'],
        handle: ['50%', '50%'],

        method: 'fill',

        bringToFrontOnDrag: false,
      });

      // Target acquisition is asynchronous, given the need to manipulate the DOM
      // - Expect the work to complete within 1 second
      // - We can only set the Picture dimensions and scale after the media stream starts, well, streaming
      // - TODO: There's probably a better, more "listenery" way to achieve this
      let checkerAttempts = 0,
        details, detailsEvent, 
        summary, summaryEvent,
        removeButton, centerButton, renameButton, 
        removeEvent, centerEvent, renameEvent;

      const checker = () => {

        setTimeout(() => {

          if (targetPicture.sourceLoaded) {

            // Assume that users won't want to be scribbling until after they position the target on the canvas
            setScribblesFlag(false);
            enableDragging();

            const [cameraWidth, cameraHeight] = targetPicture.get('copyDimensions');
            const [canvasWidth, canvasHeight] = getDimensions(currentDimension);

            const widthRatio = canvasWidth / cameraWidth,
              heightRatio = canvasHeight / cameraHeight;

            const scale = (widthRatio < 1 || heightRatio < 1) ? Math.min(widthRatio, heightRatio) / 1.5 : 1;

            targetPicture.set({
              dimensions: [cameraWidth, cameraHeight],
              scale,
            });

            const sourceTrack = mycamera.mediaStream?.getVideoTracks?.()[0] || mycamera.mediaStreamTrack;
            const sourceSettings = sourceTrack?.getSettings?.() || {};
            captureTargetMeta.set(targetId, {
              sourceWidth: Number(sourceSettings.width || cameraWidth),
              sourceHeight: Number(sourceSettings.height || cameraHeight),
              originalScale: scale,
              originalStart: ['50%', '50%'],
              crop: { x: 0, y: 0, w: 1, h: 1 },
            });
            GuideState.activeTargetName = targetId;

            // Make the Picture entity draggable
            dragGroup.addArtefacts(targetPicture);

            // Keep track of target names
            targetsPictureArray.push(targetPicture.name);

            // Each target needs a listing in the Targets modal
            details = document.createElement('details');
            details.name = 'targets-accordion';
            details.id = targetId;

            summary = document.createElement('summary');
            summary.id = `${targetId}-summary`;
            summary.textContent = targetNamesObject[targetId];
            summary.classList.add('target-summary');
            details.appendChild(summary);

            const controlsDiv = document.createElement('div');
            controlsDiv.classList.add('targets-container');

            renameButton = document.createElement('button');
            renameButton.textContent = 'Đổi tên';
            renameButton.title = 'Đổi tên nguồn';
            renameButton.classList.add('target-button');

            controlsDiv.appendChild(renameButton);
            renameEvent = scrawl.addNativeListener('click', (e) => {

              e.stopPropagation();
              renameTarget();

            }, renameButton);

            centerButton = document.createElement('button');
            centerButton.textContent = 'Căn giữa';
            centerButton.title = 'Đưa nguồn về giữa khung hình';
            centerButton.classList.add('target-button');

            controlsDiv.appendChild(centerButton);

            centerEvent = scrawl.addNativeListener('click', (e) => {

              e.stopPropagation();
              centerTarget();

            }, centerButton);

            removeButton = document.createElement('button');
            removeButton.textContent = 'Xóa';
            removeButton.title = 'Dừng và xóa nguồn này';
            removeButton.classList.add('target-button');

            controlsDiv.appendChild(removeButton);

            removeEvent = scrawl.addNativeListener('click', (e) => {

              e.stopPropagation();
              removeTarget();

            }, removeButton);

            summaryEvent = scrawl.addNativeListener('keydown', (e) => {

              if (e.target.tagName.toLowerCase() !== 'summary') return;

              if (e.shiftKey && e.key === 'ArrowUp') {

                e.preventDefault();
                moveTargetUp(details);
              }
              else if (e.shiftKey && e.key === 'ArrowDown') {

                e.preventDefault();
                moveTargetDown(details);
              }
            }, summary);

            detailsEvent = scrawl.addNativeListener('toggle', () => {

              if (details.open) {

                updateGroup.clearArtefacts();
                updateGroup.addArtefacts(targetPicture);
                updateEntityControls(targetPicture, targetNamesObject[targetId]);
              }
            }, details);

            details.appendChild(controlsDiv);
            targetsHold.insertAdjacentElement('afterbegin', details);

            updateGroup.clearArtefacts();
            updateGroup.addArtefacts(targetPicture);

            updateEntityControls(targetPicture, targetNamesObject[targetId]);
          }
          else {

            checkerAttempts++;

            if (checkerAttempts < 5) checker();
          }

        }, 200);
      }

      // Start checking
      checker();

      // Clean up the mess left behind when a media stream fails
      cleanup = () => {

        const currentUpdate = updateGroup.get('artefacts');

        if (currentUpdate.includes(targetPicture.name)) cleanupAction();

        targetPicture.kill();
        capturedTargetStreams.delete(targetId);
        captureTargetMeta.delete(targetId);
        if (GuideState.activeTargetName === targetId) GuideState.activeTargetName = null;
        mycamera.kill();
        setAppStatus('Đã xóa nguồn màn hình');

        if (details != null) {

          // scrawl.addNativeListener returns a function to remove the listener
          renameEvent();
          centerEvent();
          removeEvent();
          summaryEvent();
          detailsEvent();

          details.remove();
        }
      }

      const renameTarget = () => {

        const name = prompt('Đổi tên nguồn thành', targetNamesObject[targetId]);

        if (name != null && name.trim() !== '') {

          targetNamesObject[targetId] = name;
          updateEntityControls(targetPicture, targetNamesObject[targetId]);

          const targ = targetsHold.querySelector(`#${targetId}-summary`);
          if (targ) targ.textContent = targetNamesObject[targetId];
        }
      };

      const centerTarget = () => targetPicture.set({ start: ['50%', '50%'] });

      const removeTarget = () => {

        if (mycamera.mediaStreamTrack != null) mycamera.mediaStreamTrack.stop();
        cleanup();
      };

      const moveTargetUp = (detailsEl) => {

        const prev = detailsEl.previousElementSibling;
        if (!prev) return;

        targetsHold.insertBefore(detailsEl, prev);
        setTimeout(updateTargetOrderValues, 0);
      };

      const moveTargetDown = (detailsEl) => {

        const next = detailsEl.nextElementSibling;
        if (!next) return;

        targetsHold.insertBefore(next, detailsEl);
        setTimeout(updateTargetOrderValues, 0);
      };
    }).catch(err => { console.warn('Screen capture cancelled/failed:', err); setAppStatus('Chưa chọn nguồn màn hình', 'warning'); });
  };

  const updateTargetOrderValues = () => {

    const targets = [...targetsHold.querySelectorAll('details')];

    const len = targets.length;

    targets.forEach((t, index) => {

      const pic = scrawl.findEntity(t.id);

      if (pic) pic.set({ order: len - index });
    });
  };


  const cleanupAction = () => { 

    updateGroup.clearArtefacts();

    entityBeingEdited.textContent = 'chưa chọn nguồn';

    if (areControlsEnabled()) disableControls();

    const targets = targetsHold.querySelectorAll('details');

    [...targets].forEach(t => {

      if (t.open) t.removeAttribute('open');
    });

    setTimeout(() => targetsPanelSummary.focus(), 0);
  };

  const updateTargetScales = (oldScaler, newScaler) => {

    if (oldScaler !== newScaler) {

      targetsPictureArray.forEach(id => {

        const entity = scrawl.findEntity(id);

        if (entity) {

          const scale = entity.get('scale');

          entity.set({
            scale: ((scale / oldScaler) * newScaler),
          });
        }
      });
    }
  };

  return { 
    updateTargetScales,
    cleanupAction,
    targetNamesObject,
  };
};


// ------------------------------------------------------------------------
// Video recording and download functionality
// ------------------------------------------------------------------------
const initVideoRecording = () => {

  let selectedFiletype = 'mp4';

  // Microphone level meter state
  let audioContext,
    analyserNode,
    analyserSource,
    analyserData,
    meterAnimationId;

  const meterColorFactory = scrawl.makeColor({
    name: name('microphone-meter'),
    minimumColor: 'rgb(80 255 80)',
    maximumColor: 'rgb(255 80 80)',
    colorSpace: 'OKLAB',
  });

  const initMicrophoneAnalyser = () => {

    if (!myMicrophone || !myMicrophone.mediaStream) return;

    if (!audioContext) {

      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;

      audioContext = new Ctor();
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserData = new Uint8Array(analyserNode.frequencyBinCount);

    analyserSource = audioContext.createMediaStreamSource(myMicrophone.mediaStream);
    analyserSource.connect(analyserNode);
  };

  const updateMicrophoneMeter = () => {

    if (!analyserNode || !analyserData) {
      meterAnimationId = requestAnimationFrame(updateMicrophoneMeter);
      return;
    }

    analyserNode.getByteTimeDomainData(analyserData);

    let sumSquares = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const v = analyserData[i] - 128;
      sumSquares += v * v;
    }

    const rms = Math.sqrt(sumSquares / analyserData.length) / 128;
    const level = Math.min(Math.max(rms, 0), 1);

    meterBar.style.width = `${(level * 100).toFixed(0)}%`;
    meterBar.style.background = meterColorFactory.getRangeColor(level);

    meterAnimationId = requestAnimationFrame(updateMicrophoneMeter);
  };

  const startMicrophoneMeter = () => {

    if (!analyserNode) initMicrophoneAnalyser();

    if (!meterAnimationId && analyserNode) {
      meterAnimationId = requestAnimationFrame(updateMicrophoneMeter);
    }
  };

  const stopMicrophoneMeter = () => {

    if (meterAnimationId) {
      cancelAnimationFrame(meterAnimationId);
      meterAnimationId = null;
    }

    if (meterBar) {
      meterBar.style.width = '0%';
    }
  };

  // Microphone discovery
  DeviceManager.onChange(({ microphones }) => {

    const frag = document.createDocumentFragment();
    const none = document.createElement('option');
    none.value = 'none';
    none.textContent = 'Không dùng micro';
    frag.appendChild(none);

    microphones.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      frag.appendChild(opt);
    });

    recordingMicrophone.replaceChildren(...frag.querySelectorAll('option'));
    setTimeout(() => recordingMicrophone.value = DeviceManager.preferredMicrophone || 'none', 0);
  });

  // Initialize DOM recording button and associated modal
  recordingButton.removeAttribute('disabled');
  scrawl.addNativeListener(
    'click',
    () => {
      if (!isRecording) openModal(recordingModal, () => DeviceManager.refreshDevices());
    },
    recordingButton
  );

  scrawl.addNativeListener('click', closeModal, recordingCloseButton);
  scrawl.addNativeListener('close', closeModal, recordingModal)

  scrawl.addNativeListener('change', () => DeviceManager.preferredMicrophone = recordingMicrophone.value, recordingMicrophone);

  scrawl.addNativeListener('change', () => selectedFiletype = recordingFiletype.value, recordingFiletype);

  // Capture and release the microphone feed
  let myMicrophone;

  const startMicrophone = () => {

    if (DeviceManager.preferredMicrophone === 'none') return Promise.resolve(null);

    return new Promise((resolve, reject) => {

      if (myMicrophone) {
        const realTrack = myMicrophone.mediaStream.getAudioTracks()[0];
        if (realTrack) resolve(realTrack);
        else reject('Microphone không có luồng âm thanh khả dụng.');
        return;
      }

      scrawl.importMediaStream({
        name: name('microphone-feed'),
        audio: {
          deviceId: { exact: DeviceManager.preferredMicrophone },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
        onMediaStreamEnd: () => stopMicrophone(),
      })
      .then(res => {
        myMicrophone = res;
        const track = myMicrophone.mediaStream.getAudioTracks()[0];
        if (!track) {
          stopMicrophone();
          reject('Microphone không có luồng âm thanh khả dụng.');
          return;
        }
        initMicrophoneAnalyser();
        DeviceManager.refreshDevices();
        resolve(track);
      })
      .catch(err => {
        console.warn('Microphone error:', err);
        if (err.name === 'NotAllowedError') reject('Trình duyệt đang chặn microphone. Hãy cho phép quyền micro rồi thử lại.');
        else if (err.name === 'NotFoundError') reject('Không tìm thấy microphone.');
        else reject(`Không mở được microphone: ${err.message || err}`);
      });
    });
  };

  // Kill the camera media stream and all associated SC objects
  const stopMicrophone = () => {

    // Stop the visual meter first
    stopMicrophoneMeter();

    // Tear down Web Audio graph
    if (analyserSource) {
      analyserSource.disconnect();
      analyserSource = null;
    }

    if (analyserNode) {
      analyserNode.disconnect();
      analyserNode = null;
    }

    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    if (!myMicrophone) return;

    myMicrophone.source.srcObject = null;

    if (myMicrophone.mediaStreamTrack != null) myMicrophone.mediaStreamTrack.stop();

    myMicrophone.kill();
    myMicrophone = null;
  };

  // Local variables used by both startRecording and stopRecording functions
  let recorder, stopListener, dataCodec,
    recordingTimerIntervalValue, recordingStartedAt,
    recordingMixContext = null, recordingMixSources = [];

  const recordingFps = document.getElementById('recording-fps');
  const recordingQuality = document.getElementById('recording-quality');
  const includeSystemAudio = document.getElementById('include-system-audio');
  const recordingCountdown = document.getElementById('recording-countdown');
  const recordingDirectDisk = document.getElementById('recording-direct-disk');
  const pauseButton = document.getElementById('recording-pause-button');
  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownNumber = document.getElementById('countdown-number');

  const recordedChunks = [];
  let directSession = null;
  let directWriteQueue = Promise.resolve();
  let directWriteError = null;
  let lastRecordingTime = '00:00:00';

  // Keeping track of whether the page is currently recording, or not
  let isRecording = false;
  let isStarting = false;
  let isStopping = false;

  // Setup and start recording the canvas
  const recordingLockedButtons = [
    telepromptButton,
    telepromptTestButton,
    telepromptAreaButton,
    dimensionsButton,
  ];

  const disableRecordingTeleprompterButtons = () => {
    recordingLockedButtons.forEach(btn => btn.setAttribute('disabled', ''));
  };

  const enableRecordingTeleprompterButtons = () => {
    recordingLockedButtons.forEach(btn => btn.removeAttribute('disabled'));
  };

  const buildRecordingAudioTrack = async (microphoneTrack) => {
    const sourceTracks = [];
    if (microphoneTrack) sourceTracks.push(microphoneTrack);

    if (includeSystemAudio?.checked) {
      capturedTargetStreams.forEach(stream => {
        stream.getAudioTracks().forEach(track => {
          if (track.readyState === 'live') sourceTracks.push(track);
        });
      });
    }

    if (!sourceTracks.length) return null;

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return sourceTracks[0];

    recordingMixContext = new Ctor();
    if (recordingMixContext.state === 'suspended') await recordingMixContext.resume();
    const destination = recordingMixContext.createMediaStreamDestination();
    recordingMixSources = sourceTracks.map(track => {
      const source = recordingMixContext.createMediaStreamSource(new MediaStream([track]));
      source.connect(destination);
      return source;
    });
    return destination.stream.getAudioTracks()[0] || null;
  };

  const releaseRecordingAudioMixer = () => {
    recordingMixSources.forEach(source => { try { source.disconnect(); } catch (_) {} });
    recordingMixSources = [];
    if (recordingMixContext) {
      recordingMixContext.close().catch(() => {});
      recordingMixContext = null;
    }
  };

  const chooseRecorderOptions = () => {
    const requested = selectedFiletype;
    const customCodec = recordingCodec.value.trim();
    const candidates = [];

    if (customCodec) candidates.push(`video/${requested}; codecs="${customCodec}"`);
    if (requested === 'mp4') {
      candidates.push('video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4');
    }
    candidates.push('video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm');

    const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    const videoBitsPerSecond = Number(recordingQuality?.value || 8000000);
    return mimeType ? { mimeType, videoBitsPerSecond } : { videoBitsPerSecond };
  };

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const runCountdown = async () => {
    const seconds = Number(recordingCountdown?.value || 0);
    if (!seconds || !countdownOverlay || !countdownNumber) return;

    closeModal();
    countdownOverlay.hidden = false;

    for (let i = seconds; i >= 1; i--) {
      countdownNumber.textContent = String(i);
      countdownNumber.style.animation = 'none';
      void countdownNumber.offsetWidth;
      countdownNumber.style.animation = '';
      setAppStatus(`Bắt đầu quay sau ${i} giây`, 'working');
      await delay(1000);
    }

    countdownOverlay.hidden = true;
  };

  const startRecording = async () => {

    if (isRecording || isStarting || isStopping) return;

    isStarting = true;
    recordingStartButton.setAttribute('disabled', '');
    setAppStatus('Đang chuẩn bị ghi...', 'working');

    try {
      await runCountdown();

      const microphoneTrack = await startMicrophone();
      const fps = Number(recordingFps?.value || 30);
      const stream = canvas.base.element.captureStream(fps);
      const mixedAudioTrack = await buildRecordingAudioTrack(microphoneTrack);
      if (mixedAudioTrack) stream.addTrack(mixedAudioTrack);

      const recorderOptions = chooseRecorderOptions();
      recorder = new MediaRecorder(stream, recorderOptions);
      const actualMime = recorder.mimeType || recorderOptions.mimeType || '';
      selectedFiletype = actualMime.includes('mp4') ? 'mp4' : 'webm';

      directSession = null;
      directWriteError = null;
      directWriteQueue = Promise.resolve();
      recordedChunks.length = 0;

      if (recordingDirectDisk?.checked && DesktopBridge.available) {
        try {
          directSession = await DesktopBridge.startRecordingFile(recordingFilename.value, selectedFiletype);
          if (directSession) setAppStatus('Đã mở tệp ghi trực tiếp trên ổ đĩa', 'working');
        }
        catch (err) {
          console.warn('Direct disk mode unavailable, falling back to browser memory:', err);
          directSession = null;
          setAppStatus('Không mở được chế độ ghi thẳng · đang dùng bộ nhớ trình duyệt', 'warning');
        }
      }

      recorder.ondataavailable = event => {
        if (!event.data?.size) return;

        dataCodec = event.data.type || dataCodec;

        if (directSession?.id) {
          directWriteQueue = directWriteQueue
            .catch(() => {})
            .then(() => DesktopBridge.writeRecordingChunk(directSession.id, event.data))
            .catch(err => {
              directWriteError = err;
              console.error('Direct chunk write failed:', err);
              setAppStatus('Lỗi ghi chunk xuống ổ đĩa · tệp .partial vẫn được giữ', 'danger');
            });
        }
        else {
          recordedChunks.push(event.data);
        }
      };

      recorder.onerror = event => {
        console.error('Recorder error:', event.error || event);
        setAppStatus('Lỗi ghi video', 'danger');
      };

      recorder.onstop = () => finalizeRecording();

      isRecording = true;
      isStarting = false;
      closeModal();

      stopListener = scrawl.addNativeListener('click', stopRecording, recordingButton);
      recordingButton.classList.add('is-recording');
      recordingButton.textContent = '■ Dừng quay';

      recorder.start(1000);

      if (pauseButton) {
        pauseButton.hidden = false;
        pauseButton.classList.remove('is-paused');
        pauseButton.textContent = 'Ⅱ Tạm dừng';
      }

      if (teleprompterIsVisible) {
        populateTelepromptState();
        if (telepromptHasScript()) {
          teleprompterIsRunning = true;
          disableRecordingTeleprompterButtons();
        }
      }

      startRecordingTimer();
      if (microphoneTrack) {
        microphoneLevel.removeAttribute('aria-hidden');
        microphoneLevel.style.display = 'block';
        startMicrophoneMeter();
      }

      setAppStatus(directSession ? 'ĐANG QUAY · lưu thẳng ổ đĩa' : 'ĐANG QUAY', 'recording');
    }
    catch (err) {
      countdownOverlay.hidden = true;
      const message = typeof err === 'string' ? err : (err?.message || String(err));
      console.warn('Recording aborted:', err);
      alert(message);
      recordingStartButton.removeAttribute('disabled');
      recordingButton.classList.remove('is-recording');
      recordingButton.textContent = '● Quay';
      releaseRecordingAudioMixer();
      stopMicrophone();
      isStarting = false;
      isRecording = false;
      setAppStatus('Không thể bắt đầu quay', 'danger');
    }
  };

  let recordingPausedAt = 0;
  let recordingPausedTotal = 0;

  const startRecordingTimer = () => {

    recordingTimer.removeAttribute('aria-hidden');
    recordingTimer.style.display = 'block';
    recordingTimer.textContent = '00:00:00';
    recordingTimer.setAttribute('aria-label', 'Đã bắt đầu ghi');

    recordingStartedAt = Date.now();
    recordingPausedAt = 0;
    recordingPausedTotal = 0;
    recordingTimerIntervalValue = setInterval(recordingTimerFunction, 500);
  };

  const recordingTimerFunction = () => {

    const now = Date.now();
    const livePause = recordingPausedAt ? (now - recordingPausedAt) : 0;
    const elapsed = Math.max(0, parseInt((now - recordingStartedAt - recordingPausedTotal - livePause) / 1000, 10));

    const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0'),
      mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0'),
      secs = String(elapsed % 60).padStart(2, '0');

    recordingTimer.textContent = `${hrs}:${mins}:${secs}`;

    if (elapsed > 0 && elapsed % 15 === 0) recordingTimer.setAttribute('aria-label', `${elapsed} giây`);
  };

  const stopRecordingTimer = () => {

    clearInterval(recordingTimerIntervalValue);
    lastRecordingTime = recordingTimer.textContent || lastRecordingTime;

    recordingTimer.style.display = 'none';
    recordingTimer.setAttribute('aria-hidden', 'true');
    recordingTimer.removeAttribute('aria-label');
  };

  const buildSubtitlePayload = (lastTime) => {
    let txtString = '';
    let srtString = '';
    let vttString = 'WEBVTT\n\n';

    if (!teleprompterIsRunning) return { txtString, srtString, vttString };

    txtString = telepromptTimestamps.map(item => item.text).join('\n');
    const len = telepromptTimestamps.length - 1;

    const generateSubtitleCue = (item, index, isVtt = false) => {
      const divider = isVtt ? '.' : ',';
      const seqNo = isVtt ? '' : `${index + 1}\n`;

      if (index < len) {
        return `${seqNo}${item.time}${divider}000 --> ${telepromptTimestamps[index + 1].time}${divider}000\n${item.text}\n\n`;
      }
      return `${seqNo}${item.time}${divider}000 --> ${lastTime}${divider}000\n${item.text}\n`;
    };

    srtString = telepromptTimestamps.map((vals, idx) => generateSubtitleCue(vals, idx, false)).join('');
    vttString += telepromptTimestamps.map((vals, idx) => generateSubtitleCue(vals, idx, true)).join('');
    return { txtString, srtString, vttString };
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const finalizeRecording = async () => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nowString = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const filename = (recordingFilename.value || 'Kanrecode-recording').trim() || 'Kanrecode-recording';
    const hadTeleprompter = teleprompterIsRunning;
    const subtitle = buildSubtitlePayload(lastRecordingTime);

    try {
      await directWriteQueue;

      if (directSession?.id) {
        const finished = await DesktopBridge.finishRecordingFile(directSession.id);
        if (!finished?.ok) throw new Error(finished?.error || 'Không hoàn tất được tệp ghi trực tiếp.');

        if (hadTeleprompter) {
          const subtitleZip = await downloadZip([{
            name: `${filename}_${nowString}.subtitles.txt`,
            lastModified: now,
            input: subtitle.txtString,
          },{
            name: `${filename}_${nowString}.subtitles.srt`,
            lastModified: now,
            input: subtitle.srtString,
          },{
            name: `${filename}_${nowString}.subtitles.vtt`,
            lastModified: now,
            input: subtitle.vttString,
          },{
            name: `${filename}_${nowString}.teleprompt.txt`,
            lastModified: now,
            input: telepromptEditor.value,
          }]).blob();
          downloadBlob(subtitleZip, `${filename}_${nowString}.subtitles.zip`);
        }

        setAppStatus(
          directWriteError
            ? 'Đã lưu video nhưng có cảnh báo khi ghi chunk · hãy kiểm tra tệp'
            : 'Đã lưu video vào Videos/Kanrecode',
          directWriteError ? 'warning' : 'ready'
        );
      }
      else {
        const videoBlob = new Blob(recordedChunks, { type: dataCodec || `video/${selectedFiletype}` });

        if (!hadTeleprompter) {
          downloadBlob(videoBlob, `${filename}_${nowString}.${selectedFiletype}`);
        }
        else {
          const zipBlob = await downloadZip([{
            name: `${filename}_${nowString}.subtitles.txt`,
            lastModified: now,
            input: subtitle.txtString,
          },{
            name: `${filename}_${nowString}.subtitles.srt`,
            lastModified: now,
            input: subtitle.srtString,
          },{
            name: `${filename}_${nowString}.subtitles.vtt`,
            lastModified: now,
            input: subtitle.vttString,
          },{
            name: `${filename}_${nowString}.teleprompt.txt`,
            lastModified: now,
            input: telepromptEditor.value,
          },{
            name: `${filename}_${nowString}.video.${selectedFiletype}`,
            lastModified: now,
            input: videoBlob,
          }]).blob();

          downloadBlob(zipBlob, `${filename}_${nowString}.zip`);
        }

        setAppStatus('Đã lưu bản ghi', 'ready');
      }
    }
    catch (err) {
      console.error('Finalize recording failed:', err);
      setAppStatus('Không hoàn tất được video · tệp .partial được giữ nếu có', 'danger');
    }
    finally {
      if (hadTeleprompter) enableRecordingTeleprompterButtons();
      teleprompterIsRunning = false;

      recordingButton.classList.remove('is-recording');
      recordingButton.textContent = '● Quay';
      recordingStartButton.removeAttribute('disabled');

      if (pauseButton) {
        pauseButton.hidden = true;
        pauseButton.classList.remove('is-paused');
        pauseButton.textContent = 'Ⅱ Tạm dừng';
      }

      recorder = null;
      directSession = null;
      recordedChunks.length = 0;
      isRecording = false;
      isStarting = false;
      isStopping = false;
    }
  };

  const stopRecording = () => {

    if (!isRecording || isStopping || !recorder) return;

    isStopping = true;

    if (stopListener) {
      stopListener();
      stopListener = null;
    }

    lastRecordingTime = recordingTimer.textContent || lastRecordingTime;
    stopRecordingTimer();

    microphoneLevel.style.display = 'none';
    microphoneLevel.setAttribute('aria-hidden', 'true');
    stopMicrophoneMeter();

    if (pauseButton) {
      pauseButton.hidden = true;
      pauseButton.classList.remove('is-paused');
      pauseButton.textContent = 'Ⅱ Tạm dừng';
    }

    setAppStatus('Đang hoàn tất tệp...', 'working');

    try {
      recorder.stop();
    }
    catch (err) {
      console.error('Recorder stop failed:', err);
      isStopping = false;
      setAppStatus('Không dừng được recorder', 'danger');
      return;
    }

    stopMicrophone();
    releaseRecordingAudioMixer();
  };

  const togglePauseRecording = () => {
    if (!recorder || !isRecording || isStopping) return;

    if (recorder.state === 'recording') {
      recorder.pause();
      recordingPausedAt = Date.now();
      pauseButton?.classList.add('is-paused');
      if (pauseButton) pauseButton.textContent = '▶ Tiếp tục';
      setAppStatus('ĐANG TẠM DỪNG', 'paused');
    }
    else if (recorder.state === 'paused') {
      recorder.resume();
      if (recordingPausedAt) recordingPausedTotal += Date.now() - recordingPausedAt;
      recordingPausedAt = 0;
      pauseButton?.classList.remove('is-paused');
      if (pauseButton) pauseButton.textContent = 'Ⅱ Tạm dừng';
      setAppStatus(directSession ? 'ĐANG QUAY · lưu thẳng ổ đĩa' : 'ĐANG QUAY', 'recording');
    }
  };

  if (pauseButton) {
        pauseButton.hidden = false;
        pauseButton.classList.remove('is-paused');
        pauseButton.textContent = 'Ⅱ Tạm dừng';
      }

      if (teleprompterIsVisible) {
        populateTelepromptState();
        if (telepromptHasScript()) {
          teleprompterIsRunning = true;
          disableRecordingTeleprompterButtons();
        }
      }

      startRecordingTimer();
      if (microphoneTrack) {
        microphoneLevel.removeAttribute('aria-hidden');
        microphoneLevel.style.display = 'block';
        startMicrophoneMeter();
      }
      setAppStatus('Đang quay', 'recording');
    })
    .catch(errMsg => {
      alert(errMsg);
      console.warn('Recording aborted:', errMsg);
      recordingStartButton.removeAttribute('disabled');
      recordingButton.classList.remove('is-recording');
      recordingButton.textContent = '● Quay';
      releaseRecordingAudioMixer();
      isRecording = false;
      setAppStatus('Không thể bắt đầu quay', 'danger');
    });
  };

  const startRecordingTimer = () => {

    recordingTimer.removeAttribute('aria-hidden');
    recordingTimer.style.display = 'block';
    recordingTimer.textContent = '00:00:00';
    recordingTimer.setAttribute('aria-label', 'Recording started');

    recordingStartedAt = Date.now();
    recordingTimerIntervalValue = setInterval(recordingTimerFunction, 500);
  };

  const recordingTimerFunction = () => {

    const elapsed = parseInt((Date.now() - recordingStartedAt) / 1000, 10);

    const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0'),
      mins = String(Math.floor(elapsed / 60)).padStart(2, '0'),
      secs = String(elapsed % 60).padStart(2, '0');

    recordingTimer.textContent = `${hrs}:${mins}:${secs}`;

    if (elapsed > 0 && elapsed % 15 === 0) recordingTimer.setAttribute('aria-label', `${elapsed} seconds`);
  };

  const stopRecordingTimer = () => {

    clearInterval(recordingTimerIntervalValue);

    recordingTimer.style.display = 'none';
    recordingTimer.setAttribute('aria-hidden', 'true');
    recordingTimer.removeAttribute('aria-label');
  };

  const stopRecording = () => {

    if (isRecording) {

      stopListener();
      stopListener = null;

      stopMicrophone();
    releaseRecordingAudioMixer();
    if (pauseButton) {
      pauseButton.hidden = true;
      pauseButton.classList.remove('is-paused');
      pauseButton.textContent = 'Ⅱ Tạm dừng';
    }
    setAppStatus('Đang hoàn tất tệp...', 'working');

      recorder.stop();
      recorder = null;

      const lastTime = recordingTimer.textContent;
      stopRecordingTimer();

      microphoneLevel.style.display = 'none';
      microphoneLevel.setAttribute('aria-hidden', 'true');
      stopMicrophoneMeter();

      let txtString = '',
        srtString = '',
        vttString = 'WEBVTT\n\n';

      if (teleprompterIsRunning) {

        txtString = telepromptTimestamps.map(item => item.text).join('\n');

        const len = telepromptTimestamps.length - 1;

        const generateSubtitleCue = (item, index, isVtt = false) => {

          const divider = isVtt ? '.' : ',';

          const seqNo = isVtt ? '' : `${index + 1}\n`;

          if (index < len) {

            return `${seqNo}${item.time}${divider}000 --> ${telepromptTimestamps[index + 1].time}${divider}000\n${item.text}\n\n`;
          }
          else {

            return `${seqNo}${item.time}${divider}000 --> ${lastTime}${divider}000\n${item.text}\n`;
          }
        };

        srtString = telepromptTimestamps.map((vals, idx) => generateSubtitleCue(vals, idx, false)).join('');

        vttString += telepromptTimestamps.map((vals, idx) => generateSubtitleCue(vals, idx, true)).join('');
      }

      setTimeout(() => {

        const now = new Date();

        const pad = (n) => String(n).padStart(2, '0');

        const nowString = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

        const filename = recordingFilename.value;

        if (!teleprompterIsRunning) {

          const blob = new Blob(recordedChunks, { type: dataCodec });
          const url = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = url;
          a.download = `${filename}_${nowString}.${selectedFiletype}`;
          a.click();
          a.remove();

          URL.revokeObjectURL(url);
        }
        else {

          enableRecordingTeleprompterButtons();
          teleprompterIsRunning = false;

          const videoBlob = new Blob(recordedChunks, { type: dataCodec });

          downloadZip([{
            name: `${filename}_${nowString}.subtitles.txt`,
            lastModified: now,
            input: txtString,
          },{
            name: `${filename}_${nowString}.subtitles.srt`,
            lastModified: now,
            input: srtString,
          },{
            name: `${filename}_${nowString}.subtitles.vtt`,
            lastModified: now,
            input: vttString,
          },{
            name: `${filename}_${nowString}.teleprompt.txt`,
            lastModified: now,
            input: telepromptEditor.value,
          },{
            name: `${filename}_${nowString}.video.${selectedFiletype}`,
            lastModified: now,
            input: videoBlob,
          }])
          .blob()
          .then(blob => {

            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `${filename}_${nowString}.zip`;
            a.click();
            a.remove();

            URL.revokeObjectURL(url);
          });
        }

        recordingButton.classList.remove('is-recording');
        recordingButton.textContent = '● Quay';

        recordingStartButton.removeAttribute('disabled');

        isRecording = false;
        setAppStatus('Đã lưu bản ghi', 'ready');
      }, 0);
    }
  };

  if (pauseButton) pauseButton.addEventListener('click', togglePauseRecording);

  scrawl.addNativeListener('click', startRecording, recordingStartButton);

  return {
    startRecordingTimer,
    stopRecordingTimer,
    startRecordingNow: startRecording,
    stopRecordingNow: stopRecording,
    togglePauseRecording,
    isRecordingNow: () => isRecording,
    isStartingNow: () => isStarting,
  };
};


// ------------------------------------------------------------------------
// Background color/images controls
// ------------------------------------------------------------------------

// Initialize background image functionality
const initBackground = () => {

  scrawl.addNativeListener('focus', () => backgroundUploadButton.classList.add('is-focussed'), backgroundUpload);
  scrawl.addNativeListener('blur', () => backgroundUploadButton.classList.remove('is-focussed'), backgroundUpload);
  scrawl.addNativeListener('focus', () => backgroundColorButton.classList.add('is-focussed'), backgroundColorInput);
  scrawl.addNativeListener('blur', () => backgroundColorButton.classList.remove('is-focussed'), backgroundColorInput);

  // Background color management
  const updateBackgroundColor = () => canvas.setBase({ backgroundColor: backgroundColorInput.value });
  scrawl.addNativeListener(['input', 'change'], updateBackgroundColor, backgroundColorInput);

  // Create a Picture entity to display the background image in the canvas
  const backgroundPicture = scrawl.makePicture({

    name: name('background'),
    dimensions: ['100%', '100%'],
  });

  // Only one background image can be displayed at any time
  // - Future TODO - add in some functionality to allow users to stop showing the background image?
  let currentBackgroundAsset = null;

  // UX: Load background images into the canvas using mouse drag-and-drop functionality
  // - Handles multiple dragged files; the last file processed is the one that gets displayed
  scrawl.addNativeListener(['dragenter', 'dragover', 'dragleave'], (e) => {

    e.preventDefault();
    e.stopPropagation();

  }, canvas.domElement);

  scrawl.addNativeListener('drop', (e) => {

    e.preventDefault();
    e.stopPropagation();

    const dt = e.dataTransfer;

    if (dt) [...dt.files].forEach(addBackgroundAsset);

  }, canvas.domElement);

  // UX: Load background images into the canvas using the browser's file selector
  // - Handles multiple selected files; the last file processed is the one that gets displayed
  scrawl.addNativeListener('change', (e) => {

    e.preventDefault();
    e.stopPropagation();

    [...backgroundUpload.files].forEach(addBackgroundAsset);

  }, backgroundUpload);

  // Add each file to the Scrawl-canvas system as an asset
  let counter = 0;
  const addBackgroundAsset = (file) => {

    if (file.type.indexOf('image/') === 0) {

      // Create a name for our new asset
      const imageId = `user-upload-${counter}`;
      counter++;

      const reader = new FileReader();

      reader.readAsDataURL(file);

      reader.onloadend = function() {

        // Add the image to the DOM and create a Scrawl-canvas asset from it
        // - We wrap the <img> element in a <button> element
        // - The button then gets added to the Background modal
        // - Users can then quickly select previously uploaded images from the modal
        const img = document.createElement('img');
        img.src = reader.result;
        img.id = imageId;

        const btn = document.createElement('button');
        btn.setAttribute('data-target', imageId);

        // Function to run when user clicks on an image button in the background modal
        const buttonLoad = function () {

          const target = this.dataset.target;

          if (target) {

            const asset = scrawl.findAsset(target);

            if (asset) {
              currentBackgroundAsset = asset;

              backgroundPicture.set({ asset });
              updateBackgroundPicture();
            }
          }
        }

        scrawl.addNativeListener('click', buttonLoad, btn);

        btn.appendChild(img);
        backgroundImageHold.appendChild(btn);

        scrawl.importDomImage(`#${imageId}`);

        backgroundPicture.set({
          asset: imageId,
        });
      };

      // Async because loading an <img> element into the DOM takes its own sweet time
      setTimeout(() => {

        currentBackgroundAsset = scrawl.findAsset(imageId);
        updateBackgroundPicture();

      }, 200);
    }
    return { currentBackgroundAsset };
  };

  // Remove current background image
  const hideBackground = () => {

    currentBackgroundAsset = null;

    backgroundPicture.set({
      asset: '',
    });
  };
  scrawl.addNativeListener('click', hideBackground, backgroundImageHide);

  // Function to suitably display the background image in the canvas
  // - This emulates the <img> DOM `object-fit: cover` attribute functionality
  // - Runs whenever a new background image is loaded/selected, or the canvas dimensions change
  const updateBackgroundPicture = () => {

    if (currentBackgroundAsset != null) {

      const aWidth = currentBackgroundAsset.get('width'),
        aHeight = currentBackgroundAsset.get('height');

      const [dWidth, dHeight] = getDimensions(currentDimension);

      const rWidth = dWidth / aWidth,
        rHeight = dHeight / aHeight;

      let cX = 0,
        cY = 0,
        cWidth, cHeight;

      if (rWidth < rHeight) {

        cX = Math.floor((aWidth - (dWidth / rHeight)) / 2);
        cWidth = Math.floor(dWidth / rHeight);
        cHeight = Math.floor(dHeight / rHeight);
      }
      else {

        cY = Math.floor((aHeight - (dHeight / rWidth)) / 2);
        cWidth = Math.floor(dWidth / rWidth);
        cHeight = Math.floor(dHeight / rWidth);
      }

      backgroundPicture.set({
        copyStartX: cX,
        copyStartY: cY,
        copyWidth: cWidth,
        copyHeight: cHeight,
      });
    }
  };

  return {
    updateBackgroundPicture,
  };
};


// ------------------------------------------------------------------------
// Canvas UX interaction
// - Including drag-and-drop functionality
// ------------------------------------------------------------------------

// Build the update functionality
const initUpdates = () => {

  // The target entity controls are at the bottom of the screen
  let controlsEnabled = false;
  const areControlsEnabled = () => controlsEnabled;

  const entityControls = [entityStartX, entityStartY, entityScale, entityRoll, entityOpacity];

  const enableControls = () => {
    entityControls.forEach(control => control.removeAttribute('disabled'));
    entityFilter.removeAttribute('disabled'),
    controlsEnabled = true;
  };

  const disableControls = () => {
    entityControls.forEach(control => control.setAttribute('disabled', ''));
    entityFilter.setAttribute('disabled', '');
    controlsEnabled = false;
  };

  // Use a group to handle which entity is currently editable
  const updateGroup = scrawl.makeGroup({
    name: name('update-group'),
  });

  scrawl.makeUpdater({

    event: ['input', 'change'],
    origin: '.target-update',

    target: updateGroup,

    useNativeListener: true,
    preventDefault: true,

    updates: {
      startX: ['startX', '%'],
      startY: ['startY', '%'],
      scale: ['scale', 'float'],
      roll: ['roll', 'float'],
      opacity: ['globalAlpha', 'float'],
    },
  });

  scrawl.addNativeListener('change', () => {

    updateGroup.setArtefacts({ filters: [entityFilter.value] });

  }, entityFilter);

  // When changing between target entitys, we need to update controls to reflect current values for that entity
  const updateEntityControls = (entity, label) => {

    if (entity && label) {

      GuideState.activeTargetName = entity.name;

      updateGroup.setArtefacts({
        method: 'fill',
      });

      updateGroup.clearArtefacts();

      // Need to use a timeout here to make sure updates happen after the latest Display cycle
      setTimeout(() => {

        const [w, h] = canvas.base.get('dimensions');
        const [x, y] = entity.get('start');
        const scale = entity.get('scale');
        const roll = entity.get('roll');
        const opacity = entity.get('globalAlpha');
        const filters = entity.get('filters')[0];

        // Positioning is relative to canvas dimensions
        const pX = (x / w) * 100; 
        const pY = (y / h) * 100; 

        entityBeingEdited.textContent = label;
        entityStartX.value = `${pX}`;
        entityStartY.value = `${pY}`;
        entityScale.value = `${scale}`;
        entityRoll.value = `${roll}`;
        entityOpacity.value = `${opacity}`;

        if (!filters) entityFilter.value = 'none';
        else entityFilter.value = filters;

        updateGroup.addArtefacts(entity);

        if (!controlsEnabled) {

          enableControls();
          setTimeout(() => entityStartX.focus(), 0);
        }
        else entityStartX.focus();

      }, 0);
    }
  };

  // Build the drag functionality
  // - User can be either dragging, or scribbling; we use two groups to allow this
  // - Switch off dragging by moving all draggable entitys into dragHoldGroup
  // - Switch it back on by moving all draggable entitys into dragGroup
  const dragGroup = scrawl.makeGroup({ name: name('drag-group') });
  const dragHoldGroup = scrawl.makeGroup({ name: name('drag-hold-group') });

  // Dragging a target entity makes it the current entity for editing
  const dragger = scrawl.makeDragZone({

    zone: canvas,
    collisionGroup: dragGroup,
    exposeCurrentArtefact: true,
    endOn: ['up', 'leave'],
    updateOnEnd: () => { 

      const art = dragger().artefact;
      updateEntityControls(art, targetNamesObject[art.name]);
    },
  });

  const disableDragging = () => {

    dragHoldGroup.addArtefacts(...dragGroup.get('artefacts'));
    dragGroup.clearArtefacts();
  };

  const enableDragging = () => {

    dragGroup.addArtefacts(...dragHoldGroup.get('artefacts'));
    dragHoldGroup.clearArtefacts();
  }

  // Add in canvas click-to-unselect functionality
  // - Selecting an entity for editing happens as part of the drag-and-drop functionality
  // - This functionality cleans up things when user clicks anywhere on the canvas except over target or head entity
  const checkForCanvasClick = () => {

    const result = dragGroup.getArtefactAt(canvas.base.here);

    if (!result) cleanupAction();
  };

  scrawl.addNativeListener('click', checkForCanvasClick, canvas.domElement);

  return {
    updateGroup,
    updateEntityControls,
    areControlsEnabled,
    disableControls,
    dragGroup,
    disableDragging,
    enableDragging,
  };
};


// ------------------------------------------------------------------------
// Logo controls
// ------------------------------------------------------------------------
const initLogo = () => {

  scrawl.importDomImage('.logos');

  // State is determined by what is in the HTML code
  const logoElements = document.querySelectorAll('.logos');

  const logos = [...logoElements].map(el => {

    return {
      name: el.id,
      label: el.dataset.label || el.id,
    }
  });

  logos.forEach(logo => {

    const opt = document.createElement('option');

    opt.value = logo.name;
    opt.textContent = logo.label;

    logoChoice.appendChild(opt);
  });

  const logoGroup = scrawl.makeGroup({
    name: name('logo-group'),
    host: canvas.base,
    order: 2,
  });

  // Magic numbers for the actual dimensions of the logo image, divided by a convenient amount
  let logoPictureWidth = 0,
    logoPictureHeight = 0,
    currentLogo = logos[0].name;

  const logoPicture = scrawl.makePicture({
    name: name('logo'),
    group: logoGroup,
    asset: currentLogo,
    start: ['left', 'bottom'],
    handle: ['left', 'bottom'],
    dimensions: [logoPictureWidth, logoPictureHeight],
    copyDimensions: ['100%', '100%'],
    visibility: false,
  });

  const updateLogoChoice = () => {

    const logo = logoChoice.value;

    if (logo !== currentLogo) {

      currentLogo = logo;

      const asset = scrawl.findAsset(logo),
        scaler = getScaler(currentDimension);
      
      let width = asset.get('width'),
        height = asset.get('height');

      if (480 === scaler) {
        logoPictureWidth = width / 2.25;
        logoPictureHeight = height / 2.25;
      }
      else if (720 === scaler) {
        logoPictureWidth = width / 1.5;
        logoPictureHeight = height / 1.5;
      }
      else {
        logoPictureWidth = width;
        logoPictureHeight = height;
      }

      logoPicture.set({
        asset: logo,
        width: logoPictureWidth,
        height: logoPictureHeight,
      });
    }
  };
  scrawl.addNativeListener('change', updateLogoChoice, logoChoice);

  const updateLogoPosition = () => {

    // We invoke updateLogoChoice because image loading is async
    // - the logo is initially hidden; this will give it dimensions when first positioned 
    currentLogo = '';
    updateLogoChoice();

    switch (logoPosition.value) {

      case 'hide':
        logoPicture.set({
          visibility: false,
        });
        break;

      case 'top-left':
        logoPicture.set({
          start: ['left', 'top'],
          handle: ['left', 'top'],
          visibility: true,
        });
        break;

      case 'bottom-left':
        logoPicture.set({
          start: ['left', 'bottom'],
          handle: ['left', 'bottom'],
          visibility: true,
        });
        break;

      case 'bottom-right':
        logoPicture.set({
          start: ['right', 'bottom'],
          handle: ['right', 'bottom'],
          visibility: true,
        });
        break;

      case 'top-right':
        logoPicture.set({
          start: ['right', 'top'],
          handle: ['right', 'top'],
          visibility: true,
        });
        break;
    }
  };
  scrawl.addNativeListener('change', updateLogoPosition, logoPosition);

  return {
    updateLogoPosition,
  }
};


// ------------------------------------------------------------------------
// Scribble canvas
// - For drawing on the video while recording
// ------------------------------------------------------------------------
const initScribble = () => {

  // Initialize DOM scribbles button and associated modal
  // - The main "Scribbles" button opens an associated modal - all defined in HTML
  // - Users can use the modal to set the color and width of the scribble pen

  scrawl.addNativeListener('focus', () => scribblesColorInput.classList.add('is-focussed'), scribblesColorInput);
  scrawl.addNativeListener('blur', () => scribblesColorInput.classList.remove('is-focussed'), scribblesColorInput);
  scrawl.addNativeListener('focus', () => scribblesWidth.classList.add('is-focussed'), scribblesWidth);
  scrawl.addNativeListener('blur', () => scribblesWidth.classList.remove('is-focussed'), scribblesWidth);

  // Flag to indicate whether the user wants to scribble on the canvas, or not
  // - Required because user may also want to drag Targets around the canvas
  let scribblesAreActive = false;

  const getScribblesFlag = () => scribblesAreActive;

  const setScribblesFlag = (val, fromModal = false) => {

    val = !!val;
    scribblesAreActive = val;

    // We only need to update the modal checkbox when change is triggered from elsewhere
    if (!fromModal) {

      if (val) scribblesUseCheckbox.checked = '';
      else scribblesUseCheckbox.checked = null;
    }
  };

  scrawl.addNativeListener('change', () => {

    if (scribblesUseCheckbox.checked) {

      setScribblesFlag(true, true);
      disableDragging();
    }
    else {

      setScribblesFlag(false, true);
      enableDragging();
    }

  }, scribblesUseCheckbox);

  // Scribble color and width management
  let currentColor = '#000000',
    currentWidth = 1;

  scrawl.addNativeListener('change', () => {

    currentColor = scribblesColorInput.value;

  }, scribblesColorInput);

  scrawl.addNativeListener('change', () => {

    currentWidth = parseInt(scribblesWidth.value, 10);

  }, scribblesWidth);

  // Scribbling functionality
  // ------------------------
  const currentPins = [],
    lineHold = [],
    lineBin = [];

  let counter = 0,
    currentLine, lastX, lastY;

  const clearLines = () => {

    currentPins.length = 0;
  
    lineHold.forEach(line => line && line.kill());
    lineHold.length = 0;

    lineBin.forEach(line => line && line.kill());
    lineBin.length = 0;
  };
  scrawl.addNativeListener('click', clearLines, scribblesLineClear);

  const undoLine = () => {

    const line = lineHold.pop();

    if (line) {

        line.set({ visibility: false });
        lineBin.push(line);
    }
  };
  scrawl.addNativeListener('click', undoLine, scribblesLineUndo);

  const redoLine = () => {

    const line = lineBin.pop();

    if (line) {

        line.set({ visibility: true });
        lineHold.push(line);
    }
  };
  scrawl.addNativeListener('click', redoLine, scribblesLineRedo);

  // Accessibility
  // - CTRL + z     Clear the last line (undo)
  // - CTRL + y     Reinstate the last cleared line (redo)
  // - CTRL + x     Clear out all lines and reset (clear)
scrawl.makeKeyboardZone({

    zone: canvas,

    altOnly: {
      x: () => clearLines(),
      y: () => redoLine(),
      z: () => undoLine(),
    },
  });

  // We'll draw on a separate canvas, which then gets copied into the main canvas via a picture entity
  const scribbleCell = canvas.buildCell({
    name: name('scribble-cell'),
    dimensions: ['100%', '100%'],
    setRelativeDimensionsUsingBase: true,
    shown: false,
  });

  const getRelPos = (data) => {

    const { x, y, w, h } = data;

    const RX = `${(x / w) * 100}%`;
    const RY = `${(y / h) * 100}%`;

    return [RX, RY];
  }

  const startLine = function () {

    if (scribblesAreActive) {

      const here = canvas.getBaseHere();

      if (here.active) {

        currentPins.push(getRelPos(here));

        currentLine = scrawl.makePolyline({

          name: name(`line-${counter}`),
          group: scribbleCell.name,

          pins: currentPins,
          mapToPins: true,

          tension: 0.3,

          strokeStyle: currentColor,
          lineWidth: currentWidth,

          lineCap: 'round',
          lineJoin: 'round',

          method: 'draw',
        });

        counter++;
      }
    }
  };
  scrawl.addListener('down', startLine, canvas.domElement);

  const endLine = function () {

    if (scribblesAreActive && currentLine) lineHold.push(currentLine);

    currentLine = false;
    currentPins.length = 0;
    lastX = -1;
    lastY = -1;
  };
  scrawl.addListener(['up', 'leave'], endLine, canvas.domElement);

  const checkLine = function () {

    if (scribblesAreActive) {

      const here = canvas.getBaseHere();

      if (currentLine && here.active) {

        const {x, y} = here;

        if (x === lastX && y === lastY) return false;

        currentPins.push(getRelPos(here));

        currentLine.set({
            pins: currentPins,
        });

        lastX = x;
        lastY = y;
      }
    }
  };
  scrawl.addListener('move', checkLine, canvas.domElement);

  scrawl.makePicture({
    name: name('scribble-display'),
    asset: scribbleCell,
    dimensions: ['100%', '100%'],
    copyDimensions: ['100%', '100%'],
    order: 999,
  });

  // Need a way to trigger scribbled lines to recalculate if user changes screen (video) dimensions
  const updateAllScribbles = () => {

    lineHold.forEach(line => line.set({ tension: 0.3 }));
    lineBin.forEach(line => line.set({ tension: 0.3 }));
  };

  return {
    getScribblesFlag,
    setScribblesFlag,
    updateAllScribbles,
  };
};


// ------------------------------------------------------------------------
// Guidance tools: crop, click highlight, keystroke display, spotlight, auto zoom
// ------------------------------------------------------------------------
const initGuideTools = () => {

  const clickHighlight = document.getElementById('click-highlight');
  const showKeystrokes = document.getElementById('show-keystrokes');
  const cursorSpotlight = document.getElementById('cursor-spotlight');
  const autoZoomMode = document.getElementById('auto-zoom-mode');
  const autoZoomLevel = document.getElementById('auto-zoom-level');
  const manualZoomButton = document.getElementById('manual-zoom-button');
  const cropRegionButton = document.getElementById('crop-region-button');
  const cropResetButton = document.getElementById('crop-reset-button');
  const openRecordingsButton = document.getElementById('open-recordings-button');

  const cropOverlay = document.getElementById('crop-overlay');
  const cropSelection = document.getElementById('crop-selection');
  const cropApplyButton = document.getElementById('crop-apply-button');
  const cropCancelButton = document.getElementById('crop-cancel-button');
  const cropSizeLabel = document.getElementById('crop-size-label');

  const clickRing = scrawl.makeWheel({
    name: name('guide-click-ring'),
    start: ['50%', '50%'],
    handle: ['center', 'center'],
    radius: 18,
    lineWidth: 7,
    strokeStyle: '#78c99a',
    method: 'draw',
    globalAlpha: 0,
    visibility: false,
    order: 2200,
    noUserInteraction: true,
  });

  const keyBackdrop = scrawl.makeBlock({
    name: name('guide-key-backdrop'),
    start: ['50%', '88%'],
    handle: ['center', 'center'],
    dimensions: [220, 58],
    fillStyle: 'rgba(23, 53, 42, 0.90)',
    method: 'fill',
    visibility: false,
    order: 2210,
    noUserInteraction: true,
  });

  const keyLabel = scrawl.makeLabel({
    name: name('guide-key-label'),
    start: ['50%', '88%'],
    handle: ['center', 'center'],
    text: '',
    fontString: '700 28px "Segoe UI", Arial, sans-serif',
    fillStyle: '#ffffff',
    method: 'fill',
    visibility: false,
    order: 2211,
    noUserInteraction: true,
  });

  const makeShade = suffix => scrawl.makeBlock({
    name: name(`guide-spotlight-${suffix}`),
    start: [0, 0],
    handle: ['left', 'top'],
    dimensions: [0, 0],
    fillStyle: 'rgba(9, 38, 26, 0.34)',
    method: 'fill',
    visibility: false,
    order: 2190,
    noUserInteraction: true,
  });

  const spotlightBlocks = {
    top: makeShade('top'),
    bottom: makeShade('bottom'),
    left: makeShade('left'),
    right: makeShade('right'),
  };

  let clickAnimation = null;
  let keyHideTimer = null;
  let zoomAnimation = null;
  let zoomRestoreTimer = null;
  let zoomSnapshot = null;
  let manualZoomActive = false;
  let cropDraft = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };
  let cropDrag = null;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const getActiveTarget = () => {
    const id = GuideState.activeTargetName;
    if (!id) return null;
    const entity = scrawl.findEntity(id);
    const meta = captureTargetMeta.get(id);
    if (!entity || !meta) return null;
    return { id, entity, meta };
  };

  const mapPointerToVisibleCrop = (x, y) => {
    const target = getActiveTarget();
    if (!target) return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), inside: true };

    const crop = target.meta.crop || { x: 0, y: 0, w: 1, h: 1 };
    const inside = x >= crop.x && x <= crop.x + crop.w && y >= crop.y && y <= crop.y + crop.h;

    return {
      x: clamp((x - crop.x) / crop.w, 0, 1),
      y: clamp((y - crop.y) / crop.h, 0, 1),
      inside,
    };
  };

  const updateSpotlight = () => {
    const active = !!cursorSpotlight?.checked;
    Object.values(spotlightBlocks).forEach(block => block.set({ visibility: active }));
    if (!active) return;

    const mapped = mapPointerToVisibleCrop(GuideState.pointer.x, GuideState.pointer.y);
    const [w, h] = canvas.base.get('dimensions');
    const px = mapped.x * w;
    const py = mapped.y * h;
    const radiusX = Math.max(80, w * 0.10);
    const radiusY = Math.max(65, h * 0.12);

    const leftX = clamp(px - radiusX, 0, w);
    const rightX = clamp(px + radiusX, 0, w);
    const topY = clamp(py - radiusY, 0, h);
    const bottomY = clamp(py + radiusY, 0, h);

    spotlightBlocks.top.set({ start: [0, 0], dimensions: [w, topY] });
    spotlightBlocks.bottom.set({ start: [0, bottomY], dimensions: [w, Math.max(0, h - bottomY)] });
    spotlightBlocks.left.set({ start: [0, topY], dimensions: [leftX, Math.max(0, bottomY - topY)] });
    spotlightBlocks.right.set({ start: [rightX, topY], dimensions: [Math.max(0, w - rightX), Math.max(0, bottomY - topY)] });
  };

  const showKey = text => {
    if (!showKeystrokes?.checked || !text) return;
    const [w, h] = canvas.base.get('dimensions');
    const fontSize = Math.max(22, Math.round(w / 52));
    const boxWidth = clamp(text.length * fontSize * 0.63 + 54, 150, w * 0.66);
    const boxHeight = Math.max(52, Math.round(h * 0.075));

    keyBackdrop.set({
      dimensions: [boxWidth, boxHeight],
      visibility: true,
      globalAlpha: 1,
    });
    keyLabel.set({
      text,
      fontString: `700 ${fontSize}px "Segoe UI", Arial, sans-serif`,
      visibility: true,
      globalAlpha: 1,
    });

    clearTimeout(keyHideTimer);
    keyHideTimer = setTimeout(() => {
      keyBackdrop.set({ visibility: false });
      keyLabel.set({ visibility: false });
    }, 1500);
  };

  const pulseClick = (x, y) => {
    if (!clickHighlight?.checked) return;
    const mapped = mapPointerToVisibleCrop(x, y);
    if (!mapped.inside) return;

    const [w, h] = canvas.base.get('dimensions');
    const startRadius = Math.max(14, Math.round(Math.min(w, h) * 0.018));
    const endRadius = startRadius * 2.2;
    const started = performance.now();

    if (clickAnimation) clearInterval(clickAnimation);

    clickRing.set({
      start: [mapped.x * w, mapped.y * h],
      radius: startRadius,
      globalAlpha: 0.92,
      visibility: true,
    });

    clickAnimation = setInterval(() => {
      const t = clamp((performance.now() - started) / 430, 0, 1);
      clickRing.set({
        radius: startRadius + ((endRadius - startRadius) * t),
        globalAlpha: 0.92 * (1 - t),
      });
      if (t >= 1) {
        clearInterval(clickAnimation);
        clickAnimation = null;
        clickRing.set({ visibility: false });
      }
    }, 20);
  };

  const numericCoord = (value, total) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.endsWith('%')) return (parseFloat(value) / 100) * total;
    const n = Number(value);
    return Number.isFinite(n) ? n : total / 2;
  };

  const animateTarget = (entity, scale, startX, startY, duration = 230, onDone = null) => {
    if (zoomAnimation) clearInterval(zoomAnimation);

    const [cw, ch] = canvas.base.get('dimensions');
    const currentStart = entity.get('start');
    const fromX = numericCoord(currentStart[0], cw);
    const fromY = numericCoord(currentStart[1], ch);
    const fromScale = Number(entity.get('scale')) || 1;
    const began = performance.now();

    zoomAnimation = setInterval(() => {
      const raw = clamp((performance.now() - began) / duration, 0, 1);
      const t = 1 - Math.pow(1 - raw, 3);
      entity.set({
        scale: fromScale + ((scale - fromScale) * t),
        start: [
          fromX + ((startX - fromX) * t),
          fromY + ((startY - fromY) * t),
        ],
      });
      if (raw >= 1) {
        clearInterval(zoomAnimation);
        zoomAnimation = null;
        if (onDone) onDone();
      }
    }, 16);
  };

  const restoreZoom = () => {
    clearTimeout(zoomRestoreTimer);
    zoomRestoreTimer = null;
    manualZoomActive = false;
    manualZoomButton?.classList.remove('is-active');

    if (!zoomSnapshot) return;
    const snapshot = zoomSnapshot;
    const entity = scrawl.findEntity(snapshot.id);
    zoomSnapshot = null;
    if (!entity) return;
    animateTarget(entity, snapshot.scale, snapshot.startX, snapshot.startY, 260);
  };

  const zoomAt = (x, y, persistent = false) => {
    const target = getActiveTarget();
    if (!target) return;

    const mapped = mapPointerToVisibleCrop(x, y);
    if (!mapped.inside) return;

    const [cw, ch] = canvas.base.get('dimensions');
    const dims = target.entity.get('dimensions');
    const width = Number(dims[0]) || target.meta.sourceWidth;
    const height = Number(dims[1]) || target.meta.sourceHeight;

    if (!zoomSnapshot || zoomSnapshot.id !== target.id) {
      restoreZoom();
      const currentStart = target.entity.get('start');
      zoomSnapshot = {
        id: target.id,
        scale: Number(target.entity.get('scale')) || 1,
        startX: numericCoord(currentStart[0], cw),
        startY: numericCoord(currentStart[1], ch),
      };
    }

    const factor = Number(autoZoomLevel?.value || 1.35);
    const newScale = zoomSnapshot.scale * factor;
    const startX = (cw / 2) - ((mapped.x - 0.5) * width * newScale);
    const startY = (ch / 2) - ((mapped.y - 0.5) * height * newScale);

    animateTarget(target.entity, newScale, startX, startY, 220);

    clearTimeout(zoomRestoreTimer);
    if (!persistent) zoomRestoreTimer = setTimeout(restoreZoom, 1650);
  };

  const triggerClick = (x, y) => {
    GuideState.pointer = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    GuideState.lastClickAt = Date.now();
    updateSpotlight();
    pulseClick(GuideState.pointer.x, GuideState.pointer.y);

    if (autoZoomMode?.value === 'click') zoomAt(GuideState.pointer.x, GuideState.pointer.y, false);
  };

  const updatePointer = (x, y) => {
    GuideState.pointer = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    updateSpotlight();

    if (manualZoomActive && autoZoomMode?.value === 'manual' && zoomSnapshot) {
      zoomAt(GuideState.pointer.x, GuideState.pointer.y, true);
    }
  };

  const applyCrop = rect => {
    const target = getActiveTarget();
    if (!target) {
      setAppStatus('Hãy chọn một nguồn màn hình trước khi crop', 'warning');
      return false;
    }

    restoreZoom();

    const sourceWidth = target.meta.sourceWidth;
    const sourceHeight = target.meta.sourceHeight;
    const copyX = Math.round(sourceWidth * rect.x);
    const copyY = Math.round(sourceHeight * rect.y);
    const copyW = Math.max(2, Math.round(sourceWidth * rect.w));
    const copyH = Math.max(2, Math.round(sourceHeight * rect.h));
    const [canvasWidth, canvasHeight] = canvas.base.get('dimensions');
    const fitScale = Math.min(canvasWidth / copyW, canvasHeight / copyH);

    target.entity.set({
      copyStartX: copyX,
      copyStartY: copyY,
      copyWidth: copyW,
      copyHeight: copyH,
      dimensions: [copyW, copyH],
      start: ['50%', '50%'],
      handle: ['50%', '50%'],
      scale: fitScale,
    });

    target.meta.crop = { ...rect };
    cropRegionButton?.classList.add('is-active');
    updateEntityControls(target.entity, targetNamesObject[target.id] || target.id);
    setAppStatus(`Đã áp dụng vùng quay ${Math.round(rect.w * 100)}% × ${Math.round(rect.h * 100)}%`, 'ready');
    return true;
  };

  const resetCrop = () => {
    const target = getActiveTarget();
    if (!target) return;

    restoreZoom();
    const sourceWidth = target.meta.sourceWidth;
    const sourceHeight = target.meta.sourceHeight;

    target.entity.set({
      copyStartX: 0,
      copyStartY: 0,
      copyWidth: sourceWidth,
      copyHeight: sourceHeight,
      dimensions: [sourceWidth, sourceHeight],
      start: target.meta.originalStart,
      handle: ['50%', '50%'],
      scale: target.meta.originalScale,
    });

    target.meta.crop = { x: 0, y: 0, w: 1, h: 1 };
    cropRegionButton?.classList.remove('is-active');
    updateEntityControls(target.entity, targetNamesObject[target.id] || target.id);
    setAppStatus('Đã trở lại toàn bộ nguồn quay', 'ready');
  };

  const renderCropDraft = () => {
    const rect = cropDraft;
    cropSelection.style.left = `${rect.x * 100}%`;
    cropSelection.style.top = `${rect.y * 100}%`;
    cropSelection.style.width = `${rect.w * 100}%`;
    cropSelection.style.height = `${rect.h * 100}%`;

    const target = getActiveTarget();
    if (target) {
      cropSizeLabel.textContent = `${Math.round(target.meta.sourceWidth * rect.w)} × ${Math.round(target.meta.sourceHeight * rect.h)} px`;
    }
    else cropSizeLabel.textContent = `${Math.round(rect.w * 100)}% × ${Math.round(rect.h * 100)}%`;
  };

  const positionCropOverlay = () => {
    const rect = canvas.domElement.getBoundingClientRect();
    cropOverlay.style.left = `${rect.left}px`;
    cropOverlay.style.top = `${rect.top}px`;
    cropOverlay.style.width = `${rect.width}px`;
    cropOverlay.style.height = `${rect.height}px`;
  };

  const openCrop = () => {
    const target = getActiveTarget();
    if (!target) {
      setAppStatus('Hãy chọn một nguồn màn hình trước', 'warning');
      return;
    }

    restoreZoom();
    positionCropOverlay();
    const existing = target.meta.crop || { x: 0, y: 0, w: 1, h: 1 };
    cropDraft = (existing.w < 0.995 || existing.h < 0.995)
      ? { ...existing }
      : { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };

    cropOverlay.hidden = false;
    GuideState.cropOpen = true;
    renderCropDraft();
    setAppStatus('Kéo khung xanh để chọn vùng quay · Esc để hủy', 'working');
  };

  const closeCrop = () => {
    cropOverlay.hidden = true;
    GuideState.cropOpen = false;
    cropDrag = null;
    if (!isRecordingStatus()) setAppStatus('Sẵn sàng', 'ready');
  };

  const isRecordingStatus = () => document.getElementById('recording-modal-button')?.classList.contains('is-recording');

  const pointFromCropEvent = event => {
    const rect = cropOverlay.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  cropOverlay?.addEventListener('pointerdown', event => {
    if (event.target.closest('.crop-toolbar')) return;

    const p = pointFromCropEvent(event);
    const handle = event.target?.dataset?.handle || '';
    const insideSelection = event.target === cropSelection || !!event.target.closest('.crop-selection');

    cropDrag = {
      mode: handle ? 'resize' : insideSelection ? 'move' : 'new',
      handle,
      start: p,
      initial: { ...cropDraft },
    };

    if (cropDrag.mode === 'new') cropDraft = { x: p.x, y: p.y, w: 0.03, h: 0.03 };
    cropOverlay.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  cropOverlay?.addEventListener('pointermove', event => {
    if (!cropDrag) return;
    const p = pointFromCropEvent(event);
    const dx = p.x - cropDrag.start.x;
    const dy = p.y - cropDrag.start.y;
    const minSize = 0.03;
    const initial = cropDrag.initial;

    if (cropDrag.mode === 'new') {
      const x1 = Math.min(cropDrag.start.x, p.x);
      const y1 = Math.min(cropDrag.start.y, p.y);
      const x2 = Math.max(cropDrag.start.x, p.x);
      const y2 = Math.max(cropDrag.start.y, p.y);
      cropDraft = {
        x: clamp(x1, 0, 1 - minSize),
        y: clamp(y1, 0, 1 - minSize),
        w: Math.max(minSize, x2 - x1),
        h: Math.max(minSize, y2 - y1),
      };
    }
    else if (cropDrag.mode === 'move') {
      cropDraft = {
        ...initial,
        x: clamp(initial.x + dx, 0, 1 - initial.w),
        y: clamp(initial.y + dy, 0, 1 - initial.h),
      };
    }
    else {
      let left = initial.x;
      let top = initial.y;
      let right = initial.x + initial.w;
      let bottom = initial.y + initial.h;
      const h = cropDrag.handle;

      if (h.includes('w')) left = clamp(initial.x + dx, 0, right - minSize);
      if (h.includes('e')) right = clamp(right + dx, left + minSize, 1);
      if (h.includes('n')) top = clamp(initial.y + dy, 0, bottom - minSize);
      if (h.includes('s')) bottom = clamp(bottom + dy, top + minSize, 1);

      cropDraft = { x: left, y: top, w: right - left, h: bottom - top };
    }

    renderCropDraft();
    event.preventDefault();
  });

  cropOverlay?.addEventListener('pointerup', event => {
    cropDrag = null;
    try { cropOverlay.releasePointerCapture?.(event.pointerId); } catch (_) {}
  });

  cropApplyButton?.addEventListener('click', () => {
    if (applyCrop(cropDraft)) closeCrop();
  });
  cropCancelButton?.addEventListener('click', closeCrop);
  cropRegionButton?.addEventListener('click', openCrop);
  cropResetButton?.addEventListener('click', resetCrop);

  manualZoomButton?.addEventListener('click', () => {
    if (manualZoomActive) {
      restoreZoom();
      return;
    }
    autoZoomMode.value = 'manual';
    manualZoomActive = true;
    manualZoomButton.classList.add('is-active');
    zoomAt(GuideState.pointer.x, GuideState.pointer.y, true);
    syncHelperState();
  });

  autoZoomMode?.addEventListener('change', () => {
    if (autoZoomMode.value !== 'manual') restoreZoom();
    syncHelperState();
  });

  cursorSpotlight?.addEventListener('change', () => {
    updateSpotlight();
    syncHelperState();
  });

  clickHighlight?.addEventListener('change', syncHelperState);
  showKeystrokes?.addEventListener('change', syncHelperState);
  openRecordingsButton?.addEventListener('click', () => DesktopBridge.openRecordingsFolder());

  function syncHelperState() {
    DesktopBridge.syncState({
      keys: !!showKeystrokes?.checked,
      pointer: !!clickHighlight?.checked || !!cursorSpotlight?.checked || autoZoomMode?.value !== 'off',
    });
  }

  const canvasPoint = event => {
    const rect = canvas.domElement.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };

  window.addEventListener('pointermove', event => {
    if (DesktopBridge.available || GuideState.cropOpen) return;
    const p = canvasPoint(event);
    if (p) updatePointer(p.x, p.y);
  }, { passive: true });

  window.addEventListener('pointerdown', event => {
    if (DesktopBridge.available || GuideState.cropOpen) return;
    const p = canvasPoint(event);
    if (p) triggerClick(p.x, p.y);
  }, { passive: true });

  DesktopBridge.onEvent(event => {
    if (event.type === 'pointer') updatePointer(Number(event.x), Number(event.y));
    else if (event.type === 'click') triggerClick(Number(event.x), Number(event.y));
    else if (event.type === 'key') showKey(String(event.text || ''));
    else if (event.type === 'helper-warning') setAppStatus(event.message || 'Desktop Helper cảnh báo', 'warning');
  });

  window.addEventListener('resize', () => {
    if (GuideState.cropOpen) positionCropOverlay();
  });

  syncHelperState();

  return {
    showKey,
    triggerClick,
    updatePointer,
    openCrop,
    closeCrop,
    resetCrop,
    restoreZoom,
    toggleManualZoom: () => manualZoomButton?.click(),
    toggleKeystrokes: () => {
      showKeystrokes.checked = !showKeystrokes.checked;
      showKeystrokes.dispatchEvent(new Event('change', { bubbles: true }));
      setAppStatus(showKeystrokes.checked ? 'Hiện phím bấm: BẬT' : 'Hiện phím bấm: TẮT', 'ready');
    },
    toggleSpotlight: () => {
      cursorSpotlight.checked = !cursorSpotlight.checked;
      cursorSpotlight.dispatchEvent(new Event('change', { bubbles: true }));
    },
    toggleClickHighlight: () => {
      clickHighlight.checked = !clickHighlight.checked;
      clickHighlight.dispatchEvent(new Event('change', { bubbles: true }));
    },
    isKeystrokesEnabled: () => !!showKeystrokes.checked,
    syncHelperState,
  };
};


// ------------------------------------------------------------------------
// Global shortcuts
// ------------------------------------------------------------------------
const initGlobalShortcuts = (recordingApi, guideApi) => {

  const lastActionAt = new Map();

  const runAction = action => {
    const now = performance.now();
    const previous = lastActionAt.get(action) || 0;
    if (now - previous < 220) return;
    lastActionAt.set(action, now);

    switch (action) {
      case 'record-toggle':
        if (recordingApi.isRecordingNow()) recordingApi.stopRecordingNow();
        else if (!recordingApi.isStartingNow()) recordingApi.startRecordingNow();
        break;

      case 'pause-toggle':
        recordingApi.togglePauseRecording();
        break;

      case 'keys-toggle':
        guideApi.toggleKeystrokes();
        break;

      case 'draw-toggle':
        scribblesUseCheckbox.checked = !scribblesUseCheckbox.checked;
        scribblesUseCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        setAppStatus(scribblesUseCheckbox.checked ? 'Bút chú thích: BẬT' : 'Bút chú thích: TẮT', 'ready');
        break;

      case 'crop':
        guideApi.openCrop();
        break;

      case 'zoom-toggle':
        guideApi.toggleManualZoom();
        break;

      case 'click-toggle':
        guideApi.toggleClickHighlight();
        break;

      case 'spotlight-toggle':
        guideApi.toggleSpotlight();
        break;
    }
  };

  const keyText = event => {
    const key = event.key;
    const modifierKeys = ['Control', 'Shift', 'Alt', 'Meta'];
    const special = new Set([
      'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
      'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ',
    ]);

    const parts = [];
    if (event.ctrlKey && key !== 'Control') parts.push('Ctrl');
    if (event.shiftKey && key !== 'Shift') parts.push('Shift');
    if (event.altKey && key !== 'Alt') parts.push('Alt');
    if (event.metaKey && key !== 'Meta') parts.push('Win');

    let label = key;
    if (key === ' ') label = 'Space';
    else if (key === 'Escape') label = 'Esc';
    else if (key === 'ArrowUp') label = '↑';
    else if (key === 'ArrowDown') label = '↓';
    else if (key === 'ArrowLeft') label = '←';
    else if (key === 'ArrowRight') label = '→';
    else if (key === 'Control') label = 'Ctrl';
    else if (key === 'Meta') label = 'Win';

    const hasStrongModifier = event.ctrlKey || event.altKey || event.metaKey;
    const safeSingleKey = special.has(key) || /^F\d{1,2}$/.test(key) || modifierKeys.includes(key);

    // Privacy: do not display plain letters/numbers typed without Ctrl/Alt/Win.
    if (!safeSingleKey && !hasStrongModifier) return '';

    if (!parts.length || parts[parts.length - 1] !== label) parts.push(label);
    return parts.join(' + ');
  };

  const actionFromKeyboardEvent = event => {
    const key = String(event.key || '').toLowerCase();

    if (event.key === 'F9') return 'record-toggle';
    if (event.key === 'F10') return 'pause-toggle';

    if (event.ctrlKey && event.shiftKey && key === 'k') return 'keys-toggle';
    if (event.ctrlKey && event.shiftKey && key === 'd') return 'draw-toggle';
    if (event.ctrlKey && event.shiftKey && key === 'r') return 'crop';
    if (event.ctrlKey && event.shiftKey && key === 'j') return 'zoom-toggle';
    if (event.ctrlKey && event.shiftKey && key === 'h') return 'click-toggle';
    if (event.ctrlKey && event.shiftKey && key === 'l') return 'spotlight-toggle';
    return '';
  };

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (GuideState.cropOpen) {
        event.preventDefault();
        guideApi.closeCrop();
        return;
      }
      if (currentModal) {
        event.preventDefault();
        closeModal();
        return;
      }
      if (scribblesUseCheckbox.checked) {
        scribblesUseCheckbox.checked = false;
        scribblesUseCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }

    const action = actionFromKeyboardEvent(event);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      runAction(action);
    }

    if (!DesktopBridge.available && guideApi.isKeystrokesEnabled()) {
      const text = keyText(event);
      if (text) guideApi.showKey(text);
    }
  }, true);

  DesktopBridge.onEvent(event => {
    if (event.type === 'shortcut' && event.action) runAction(event.action);
  });

  return { runAction };
};


// ------------------------------------------------------------------------
// Control buttons management
// ------------------------------------------------------------------------
const dom = scrawl.initializeDomInputs([

  // Capture handles to the editing controls
  ['by-id', 'entity-being-edited'],
  ['by-id', 'current-canvas-dimensions'],
  ['input', 'startX', '50'],
  ['input', 'startY', '50'],
  ['input', 'scale', '1'],
  ['input', 'roll', '0'],
  ['input', 'opacity', '1'],
  ['select', 'target-filter', 0],

  // Capture handles to the head controls
  ['select', 'talking-head-camera', 0],
  ['input', 'use-talking-head', 'off'],
  ['input', 'show-talking-head', 'on'],
  ['input', 'head-horizontal', '75'],
  ['input', 'head-vertical', '75'],
  ['input', 'head-scale', '0.5'],
  ['input', 'head-opacity', '1'],
  ['input', 'head-rotation', '0'],
  ['input', 'head-shape', '15'],
  ['select', 'head-background', 1],
  ['select', 'head-filter', 0],

  // Capture handles to the recording controls
  ['button', 'recording-modal-button', '● Quay'],
  ['button', 'recording-modal-close', '×'],
  ['by-id', 'recording-modal'],
  ['select', 'recording-microphone', 0],
  ['input', 'file-name', 'Kanrecode-recording'],
  ['select', 'video-output-filetype', 0],
  ['input', 'video-output-codec', ''],
  ['button', 'recording-start-button', '● Bắt đầu quay'],

  // Capture handles to the recording visual display elements
  ['by-id', 'recording-timer'],
  ['by-id', 'microphone-level'],
  ['by-id', 'meter-bar'],

  // Capture handles to the targets-related HTML elements
  ['button', 'target-request-button', '＋ Chọn màn hình'],
  ['by-id', 'current-targets-hold'],
  ['by-id', 'targets-panel-summary'],

  // Capture handles to the background-related HTML elements
  ['input', 'background-upload', ''],
  ['by-id', 'background-upload-button'],
  ['input', 'background-color-input', '#ffffff'],
  ['by-id', 'background-color-button'],
  ['by-id', 'background-image-hold'],
  ['button', 'background-image-hide', 'Ẩn ảnh nền'],

  // Capture handles to the dimensions-related HTML elements
  ['button', 'dimensions-modal-button', '▣ Khung hình'],
  ['button', 'dimensions-modal-close', '×'],
  ['by-id', 'dimensions-modal'],
  ['select', 'video-dimensions', 1],

  // Capture handles to the dimensions-related HTML elements
  ['input', 'use-scribbles', 'off'],
  ['input', 'scribbles-color-input', '#000000'],
  ['input', 'scribbles-width', '1'],
  ['button', 'scribbles-line-undo', '↶ Hoàn tác'],
  ['button', 'scribbles-line-redo', '↷ Làm lại'],
  ['button', 'scribbles-line-clear', '⌫ Xóa nét'],

  // Capture handles to the logo positioning selector
  ['select', 'logo-choice', 0],
  ['select', 'logo-position', 0],

  // Capture handles for the instructions modal
  ['button', 'instructions-modal-button', '? Hướng dẫn nhanh'],
  ['button', 'instructions-modal-close', '×'],
  ['by-id', 'instructions-modal'],

  // Capture handles for the teleprompter modal and controls
  ['button', 'teleprompt-area-button', '▤ Teleprompter'],
  ['button', 'teleprompt-editor-modal-button', 'Sửa lời thoại'],
  ['button', 'teleprompt-editor-modal-close', '×'],
  ['button', 'teleprompt-test-button', 'Chạy thử'],
  ['by-id', 'teleprompt-editor-modal'],
  ['by-id', 'teleprompt-editor'],
  ['by-id', 'teleprompter-reading'],
  ['by-id', 'teleprompter-stage'],
  ['by-id', 'app-panel'],
]);

const entityBeingEdited = dom['entity-being-edited'],
  currentCanvasDimensions = dom['current-canvas-dimensions'],
  entityStartX = dom['startX'],
  entityStartY = dom['startY'],
  entityScale = dom['scale'],
  entityRoll = dom['roll'],
  entityOpacity = dom['opacity'],
  entityFilter = dom['target-filter'],

  headUseCheckbox = dom['use-talking-head'],
  headCamera = dom['talking-head-camera'],
  headShowCheckbox = dom['show-talking-head'],
  headHorizontal = dom['head-horizontal'],
  headVertical = dom['head-vertical'],
  headScale = dom['head-scale'],
  headOpacity = dom['head-opacity'],
  headRotation = dom['head-rotation'],
  headShape = dom['head-shape'],
  headBackground = dom['head-background'],
  headFilter = dom['head-filter'],

  recordingModal = dom['recording-modal'],
  recordingButton = dom['recording-modal-button'],
  recordingCloseButton = dom['recording-modal-close'],
  recordingMicrophone = dom['recording-microphone'],
  recordingFilename = dom['file-name'],
  recordingFiletype = dom['video-output-filetype'],
  recordingCodec = dom['video-output-codec'],
  recordingStartButton = dom['recording-start-button'],

  recordingTimer = dom['recording-timer'],
  microphoneLevel = dom['microphone-level'],
  meterBar = dom['meter-bar'],

  targetRequestButton = dom['target-request-button'],
  targetsHold = dom['current-targets-hold'],
  targetsPanelSummary = dom['targets-panel-summary'],

  backgroundUpload = dom['background-upload'],
  backgroundUploadButton = dom['background-upload-button'],
  backgroundColorInput = dom['background-color-input'],
  backgroundColorButton = dom['background-color-button'],
  backgroundImageHold = dom['background-image-hold'],
  backgroundImageHide = dom['background-image-hide'],

  dimensionsModal = dom['dimensions-modal'],
  dimensionsButton = dom['dimensions-modal-button'],
  dimensionsCloseButton = dom['dimensions-modal-close'],
  dimensionsSelector = dom['video-dimensions'],

  scribblesUseCheckbox = dom['use-scribbles'],
  scribblesColorInput = dom['scribbles-color-input'],
  scribblesWidth = dom['scribbles-width'],
  scribblesLineUndo = dom['scribbles-line-undo'],
  scribblesLineRedo = dom['scribbles-line-redo'],
  scribblesLineClear = dom['scribbles-line-clear'],

  logoChoice = dom['logo-choice'],
  logoPosition = dom['logo-position'],

  telepromptAreaButton = dom['teleprompt-area-button'],
  telepromptModal = dom['teleprompt-editor-modal'],
  telepromptButton = dom['teleprompt-editor-modal-button'],
  telepromptCloseButton = dom['teleprompt-editor-modal-close'],
  telepromptTestButton = dom['teleprompt-test-button'],
  telepromptEditor = dom['teleprompt-editor'],
  telepromptReading = dom['teleprompter-reading'],
  telepromptStage = dom['teleprompter-stage'],
  appPanel = dom['app-panel'],

  instructionsModal = dom['instructions-modal'],
  instructionsButton = dom['instructions-modal-button'],
  instructionsCloseButton = dom['instructions-modal-close'];




// Refresh device labels after permissions may have been granted during use.
[headCamera, recordingMicrophone].forEach(el => {
  el?.addEventListener('focus', () => DeviceManager.refreshDevices(), { passive: true });
});

// ------------------------------------------------------------------------
// Filter effects
// ------------------------------------------------------------------------
scrawl.makeFilter({
  name: 'none',
  actions: [],
});

scrawl.makeFilter({
  name: 'blur',
  method: 'gaussianBlur',
  radius: 20,
  excludeTransparentPixels: true,
});

scrawl.makeFilter({
  name: 'gray',
  method: 'grayscale',
});

scrawl.makeFilter({
  name: 'monochrome',
  method: 'reducePalette',
  noiseType: 'bluenoise',
});

scrawl.makeFilter({
  name: 'sharpen',
  method: 'sharpen',
});

scrawl.makeFilter({
  name: 'nowhite',
  method: 'chroma',
  ranges: [[250, 250, 250, 255, 255, 255]],
  feather: 8,
});

// ------------------------------------------------------------------------
// Start the page running
// - Attempted to make the ordering of these invocations as irrelevant as possible
// - Be wary of including function calls defined in other invocations in an invocation function
// ------------------------------------------------------------------------

const {
  setScribblesFlag,
  updateAllScribbles,
} = initScribble();

const {
  updateLogoPosition,
} = initLogo();

const {
  updateGroup,
  updateEntityControls,
  areControlsEnabled,
  disableControls,
  dragGroup,
  disableDragging,
  enableDragging,
} = initUpdates();

const { 
  getDimensions,
  getScaler,
} = initDimensions();

const { 
  updateTargetScales,
  cleanupAction,
  targetNamesObject,
} = initTargets();

initTalkingHead();

const {
  updateBackgroundPicture,
} = initBackground();

const {
  startRecordingTimer,
  stopRecordingTimer,
} = initVideoRecording();

const {
  telepromptTimestamps,
  displayNextTelepromptLine,
  populateTelepromptState,
  telepromptHasScript,
} = initTeleprompter();

initInstructions();


// ------------------------------------------------------------------------
// Scrawl-canvas animation
// ------------------------------------------------------------------------
scrawl.makeRender({

  name: name('render'),
  target: canvas,
});

// ------------------------------------------------------------------------
// Request permissions
// ------------------------------------------------------------------------
DeviceManager.refreshDevices();
