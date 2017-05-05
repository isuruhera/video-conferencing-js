const HTTPS_PORT = 8080;

const TYPE_INITIAL_HANDSHAKE = 0;
const TYPE_SDP_CONNECTION = 1;
const TYPE_ICE_INFO = 2;
const TYPE_BITRATE_CHANGED_INFO = 3;
const TYPE_CHAT_MESSAGE = 4;
const TYPE_REQUEST_OFFER = 5;

const CHANGE_LOCAL_BITRATE_EVENT_NAME = "video-conf-local-bitrate-change";
const CHANGE_REMOTE_BITRATE_EVENT_NAME = "video-conf-remote-bitrate-change";

var selfVideoElement;
var remoteUserVideoElement;

var peerConnection;
var serverConnection;

var id = "TEMP";
var name = "Name";

var stats;

var currentBitrate = 1;
var currentBitrateChangeTolerance = 0;
var bitrateManualOverride = true;

var currentSenders = [];
var currentStream;

var isCaller = false;

//ICE servers are required for webRTC to function specially if the users 
//are behind NAT or a firewall
const peerConfiguration = {
    'iceServers': [
        { 'urls': 'stun:stun.l.google.com:19302' },
        { 'urls': 'stun:stun.services.mozilla.com' },
    ]
};

function pageReady() {
    remoteUserVideoElement = document.getElementById('remoteVideo');
    selfVideoElement = document.getElementById('localVideo');

    id = sessionStorage.getItem("session-id");
    name = sessionStorage.getItem("session-name");
    console.log("Got id " + id + " and name " + name);

    serverConnection = new WebSocket('wss://' + window.location.hostname + ':' + HTTPS_PORT);
    serverConnection.onmessage = serverOnMessageCallback;
    serverConnection.onopen = function(event) {
        var msg = {
            "type": TYPE_INITIAL_HANDSHAKE,
            "id": id,
            "name": name,
            "date": Date.now()
        };

        serverConnection.send(JSON.stringify(msg));
    };

    if (initVideoStream(false)) { //browser supports WebRTC
        document.addEventListener(CHANGE_LOCAL_BITRATE_EVENT_NAME, onLocalBitrateChange);
    } else {
        serverConnection.close();
        alert('Sorry, your browser does not support WebRTC');
    }
}

function getOptimalVideoParams() {
    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    var idealFramerate = 24;
    var maximumFrameRate = 25;

    var isAudioEnabled = true;
    var isVideoEnabled = true;

    var idealResolution = [1024, 768]; //Index 0 - width, 1 - height
    var maxResolution = [1280, 720]; //Index 0 - width, 1 - height

    if (currentBitrate < 0.01) { //lowest quality
        isVideoEnabled = false;
        isAudioEnabled = true;
    } else if (currentBitrate < 0.1) {
        isVideoEnabled = false;
    } else if (currentBitrate < 0.5) {
        idealResolution = [256, 144];
        maxResolution = [320, 240];
        idealFramerate = 5;
        maximumFrameRate = 10;
    } else if (currentBitrate < 1) {
        idealResolution = [640, 480];
        maxResolution = [720, 576];
        idealFramerate = 15;
        maximumFrameRate = 20;
    } else if (currentBitrate < 1.5) {
        idealResolution = [1280, 720];
        maxResolution = [1920, 1080];
        idealFramerate = 24;
        maximumFrameRate = 25;
    } else if (currentBitrate < 2) { //2mbps - can provide a good quality
        idealResolution = [1920, 1080];
        maxResolution = [2560, 1440];
        idealFramerate = 25;
        maximumFrameRate = 60;
    }

    var mediaParams = {}
    if (!isVideoEnabled) {
        mediaParams.video = false;
    } else {
        mediaParams.video = {
            width: {
                ideal: idealResolution[0],
                max: maxResolution[0]
            },
            height: {
                ideal: idealResolution[1],
                max: maxResolution[1]
            },
            framerate: {
                ideal: idealFramerate,
                max: maximumFrameRate
            },
            facingMode: "user" //prioritize front facing camera 
        }
    }

    if (!isAudioEnabled) {
        mediaParams.audio = false;
    } else {
        mediaParams.audio = true;
    }

    return mediaParams;
}

function start(isCaller) {
    this.isCaller = isCaller;

    peerConnection = new RTCPeerConnection(peerConfiguration);
    peerConnection.onaddstream = peerOnAddStreamCallback;
    peerConnection.onicecandidate = peerOnIceCandidateCallback;

    if (navigator.mozGetUserMedia) { //Firefox and Chrome uses different API
        currentStream.getTracks().forEach(function(track) {
            currentSenders.push(peerConnection.addTrack(track, currentStream));
        });
    } else {
        peerConnection.addStream(currentStream);
    }

    if (isCaller) {
        peerConnection.createOffer().then(onCreateVideoDesc).catch(errorHandler);
    }
}

function serverOnMessageCallback(message) {
    if (!peerConnection) {
        start(false);
    }

    var signal = JSON.parse(message.data);

    // Ignore messages from ourself
    if (signal.id == id) {
        return;
    }

    if (signal.sdp) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function() {
            if (signal.sdp.type == 'offer') { // Only create answers in response to offers
                peerConnection.createAnswer().then(onCreateVideoDesc).catch(errorHandler);
            }
        }).catch(errorHandler);
    } else if (signal.ice) {
        peerConnection.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
    } else if (signal.bitrate) {
        onRemoteBitrateChange(signal.bitrate);
    } else if (signal.chat) {
        onChatMessageReceived(signal);
    } else if (signal.type == TYPE_REQUEST_OFFER) {
        peerConnection.createOffer().then(onCreateVideoDesc).catch(errorHandler);
    }
}

function peerOnIceCandidateCallback(event) {
    if (event.candidate != null) {
        serverConnection.send(JSON.stringify({
            'type': TYPE_ICE_INFO,
            'ice': event.candidate,
            'id': id
        }));
    }
}

function peerOnAddStreamCallback(event) {
    console.log('Received remote stream');
    remoteUserVideoElement.src = window.URL.createObjectURL(event.stream);

    listenToBandwithStats();
}

function onCreateVideoDesc(description) {
    peerConnection.setLocalDescription(description).then(function() {
        serverConnection.send(JSON.stringify({
            'type': TYPE_SDP_CONNECTION,
            'sdp': peerConnection.localDescription,
            'id': id
        }));
    }).catch(errorHandler);
}

//Callback function called when the local bitrate is changed
function onLocalBitrateChange(data) {
    console.log("Local Bitrate change event received - New bitrate " + data.detail);
    serverConnection.send(JSON.stringify({ //inform the remote user
        'type': TYPE_BITRATE_CHANGED_INFO,
        'bitrate': data.detail,
        'id': id
    }));

    initVideoStream(true);
}

//Callback function called when the remote bitrate is changed
function onRemoteBitrateChange(data) {
    var difference = Math.abs(data - currentBitrate);
    if (difference > 0.2) {
        console.log("Changing bitrate due to remote bitrate change event");
        initVideoStream(true);
    } else {
        console.log("Remote bitrate event discarded due to low difference of " + difference);
    }
}

//Initialize the video stream
function initVideoStream(addToConnection) {
    var previousStream = currentStream;
    if (navigator.mediaDevices.getUserMedia) { //check if browser supports webrtc
        var promise = navigator.mediaDevices.getUserMedia(getOptimalVideoParams());
        promise.then(function(stream) {
            currentStream = stream;
            selfVideoElement.src = window.URL.createObjectURL(stream); //start showing the video

            if (addToConnection) {
                if (navigator.mozGetUserMedia && currentSenders.length > 0) {
                    currentSenders.forEach(function(sender) {
                        peerConnection.removeTrack(sender);
                    });
                    currentSenders = [];

                    stream.getTracks().forEach(function(track) {
                        currentSenders.push(peerConnection.addTrack(track, stream));
                    });
                } else if (previousStream) {
                    peerConnection.removeStream(previousStream);
                    peerConnection.addStream(currentStream);
                }

                if (isCaller) { //create offer ourselves
                    peerConnection.createOffer().then(onCreateVideoDesc).catch(errorHandler);
                } else { //request offer from other party
                    serverConnection.send(JSON.stringify({
                        'type': TYPE_REQUEST_OFFER,
                        'id': id
                    }));
                }
            }
        }).catch(errorHandler);
        return true;
    } else {
        return false;
    }
}

//Called when the remote party send a chat message
function onChatMessageReceived(data) {
    var element = document.getElementById("comment");
    var currentText = element.value;
    var message = data.name + " : " + data.chat + "\n";
    currentText = currentText + message;
    element.value = currentText;
}

//Called when the user send a chat message
function onSendChatMessage() {
    var textBox = document.getElementById("chat");
    var message = textBox.value;
    serverConnection.send(JSON.stringify({
        'type': TYPE_CHAT_MESSAGE,
        'chat': message,
        'id': id,
        "name": name
    }));

    var element = document.getElementById("comment");
    var currentText = element.value;
    var message = name + " : " + message + "\n";
    currentText = currentText + message;
    element.value = currentText;

    textBox.value = "";
}

function onManualBandwidthSet(val) {
    if (val == -1) {
        bitrateManualOverride = false;
    } else {
        bitrateManualOverride = true;
        currentBitrate = val;
        initVideoStream(true);
    }
}

function errorHandler(error) {
    console.log(error);
}

//Listen to bandwidth stats from the streams
function listenToBandwithStats() {
    if (navigator.mozGetUserMedia) {
        console.log("Using Firefox stats API");

        setInterval(function() {
            if (!bitrateManualOverride) {
                var selector = getStreamToListenOn();
                peerConnection.getStats(selector).then(function(report) {
                    console.log("Stats report received");

                    var selectedReportType;
                    report.forEach(function(element) {
                        if (element.type == "inbound-rtp" || element.type == "inboundrtp") {
                            selectedReportType = element;
                        }
                    });

                    var bitrate = (selectedReportType.bitrateMean / 1000000).toFixed(2); //convert to mbps
                    if (shouldTransmitBitrateEvent(bitrate)) {
                        var event = new CustomEvent(CHANGE_LOCAL_BITRATE_EVENT_NAME, {
                            "detail": bitrate
                        })

                        document.dispatchEvent(event); //transmit the event
                        console.log("Bitrate change event transmitted - Bitrate " + bitrate + " Mbps");
                    } else {
                        console.log("New bitrate " + bitrate + " not transmitted | Previous bitrate " + currentBitrate);
                    }

                    currentBitrate = bitrate;
                }).catch(errorHandler);
            }
        }, 2000);
    } else {
        console.log("Using Chrome/WebKit stats API");

        if (!bitrateManualOverride) {
            stats = getStats(peerConnection, function(result) {
                try {
                    var bandwidth = result.video.bandwidth.googTransmitBitrate;
                    if (bandwidth) {
                        bandwidth = parseInt(bandwidth);
                        var bitrate = (bandwidth / 1000000).toFixed(2); //convert to mbps

                        if (shouldTransmitBitrateEvent(bitrate)) {
                            var event = new CustomEvent(CHANGE_LOCAL_BITRATE_EVENT_NAME, {
                                "detail": bitrate
                            })

                            document.dispatchEvent(event); //transmit the event
                            console.log("Bitrate change event transmitted - Bitrate " + bitrate + " Mbps");
                        } else {
                            console.log("New bitrate " + bitrate + " not transmitted | Previous bitrate " + currentBitrate);
                        }

                        currentBitrate = bitrate;
                    }
                } catch (err) {
                    console.log("Bandwidth calculation failed");
                }
            }, 2000);
        }
    }
}

//Check the tolerance to transmit the bitrate change event
function shouldTransmitBitrateEvent(newBitrate) {
    if (currentBitrate == 0) {
        return true; //always transmit if bitrate was 0 before
    }

    if (currentBitrate == newBitrate) {
        return false;
    }

    var toleranceThreshold = 0.2;
    currentBitrateChangeTolerance += Math.abs(currentBitrate - newBitrate);
    if (currentBitrateChangeTolerance > toleranceThreshold) {
        currentBitrateChangeTolerance = 0;
        return true;
    } else {
        return false;
    }
}

//get the stream that the application should use to 
//calculate the current bitrate (preferably the remote user's video stream)
//Supported in Firefox only
function getStreamToListenOn() {
    try {
        var availableStreams = peerConnection.getReceivers();
        var selectedStream;
        if (availableStreams) {
            for (var stream of availableStreams) {
                selectedStream = stream.track;

                if (selectedStream.kind == "video") {
                    break; //prioritize video stream (if available)
                }
            }
        }

        return selectedStream;
    } catch (error) { //Browser does not support peerConnection.getReceivers()
        console.log("Unable to detect bandwith in this browser");
    }
}