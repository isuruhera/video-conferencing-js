const HTTPS_PORT = 8080;

const TYPE_INITIAL_HANDSHAKE = 0;
const TYPE_SDP_CONNECTION = 1;
const TYPE_ICE_INFO = 2;

var selfVideoElement;
var remoteUserVideoElement;

var peerConnection;
var serverConnection;

var id = "TEMP"; //TODO - get it from user

var stats;

//ICE servers are required for webRTC to function specially if the users 
//are behind NAT or a firewall
const peerConfiguration = {
    'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun.services.mozilla.com'},
    ]
};

function pageReady() {
    remoteUserVideoElement = document.getElementById('remoteVideo');
    selfVideoElement = document.getElementById('localVideo');
    
    serverConnection = new WebSocket('wss://' + window.location.hostname + ':' + HTTPS_PORT);
    serverConnection.onmessage = serverOnMessageCallback;
    serverConnection.onopen = function(event) {
        var msg = {
            "type": TYPE_INITIAL_HANDSHAKE,
            "id": id,
            "date": Date.now()
        };

        serverConnection.send(JSON.stringify(msg));
    };

    if (navigator.mediaDevices.getUserMedia) {
        var promise = navigator.mediaDevices.getUserMedia(getOptimalVideoParams());
        promise.then(function(stream) {
            localStream = stream;
            selfVideoElement.src = window.URL.createObjectURL(stream); //start showing the video on page ready
        }).catch(errorHandler);
    } else {
        alert('Sorry, your browser does not support WebRTC');
    }
}

function getOptimalVideoParams() {
    //TODO - Detect the bandwith and customize video params
    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    return mediaParams = {
        video: { facingMode: "user" }, //prioritize front facing camera 
        audio: false,
    };
}

function start(isCaller) {
    peerConnection = new RTCPeerConnection(peerConfiguration);
    peerConnection.onaddstream = peerOnAddStreamCallback;
    peerConnection.onicecandidate = peerOnIceCandidateCallback;

    peerConnection.addStream(localStream);

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
        //return;
    }

    if (signal.sdp) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function() {
            if(signal.sdp.type == 'offer') { // Only create answers in response to offers
                peerConnection.createAnswer().then(onCreateVideoDesc).catch(errorHandler);
            }
        }).catch(errorHandler);
    } else if (signal.ice) {
        peerConnection.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
    }
}

function peerOnIceCandidateCallback(event) {
    if(event.candidate != null) {
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

function errorHandler(error) {
    console.log(error);
}


function listenToBandwithStats() {
    if (navigator.mozGetUserMedia) { 
        console.log("Using Firefox stats API");
        setInterval(function() {
            peerConnection.getStats(peerConnection.getRemoteStreams()[0].getVideoTracks()[0], function(results) {
                var obj = results.inbound_rtp_video_0;
                if (obj) {
                    var bitrate = (obj.bitrateMean/1000000).toFixed(2);
                    console.log("Bitrate " + bitrate + " Mbps");
                }
            }, errorHandler);
        }, 1000);
    } else {
        console.log("Using Chrome/WebKit stats API");
        stats = getStats(peerConnection, function (result) {
            console.log(result);
        }, 1000);
    }
}