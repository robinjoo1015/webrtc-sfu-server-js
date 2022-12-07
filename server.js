const cors = require("cors")
const express = require("express")
const app = express()
const server = require("http").createServer(app)

const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: [
            "*",
            // "http://localhost:3000",
        ],
        methods: ["GET", "POST"],
        transports: ['websocket', 'polling'],
        credentials: true
    },
    allowEIO3: true,
    allowEIO4: true,
})

// const socketio = require("socket.io")(server, {
//     cors: {
//         origin: [
//             "http://localhost:3000",
//         ],
//         methods: ["GET", "POST"],
//         transports: ['websocket'],
//         credentials: true
//     },
//     allowEIO3: true,
//     allowEIO4: true,
// })

let wrtc = undefined
if (process.platform === "darwin" && process.arch === "arm64") {
    console.log("running on @koush/wrtc")
    wrtc = require("@koush/wrtc") // macOS + arm64
} else {
    console.log("running on wrtc")
    wrtc = require("wrtc")
}

// const server = http.createServer(app);

// const whitelist = new Set([
//     'http://localhost:3000/',
//     'https://localhost:3000/',
//     'http://localhost:8080/',
//     'https://localhost:8080/',
// ])

// const corsOptions = {
//     origin: function (origin, callback) {
//         if (!origin || whitelist.has(origin)) {
//             callback(undefined, true);
//         } else {
//             callback(new Error('Not allowed by CORS!'));
//         }
//     },
//     methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
//     optionsSuccessStatus: 200,
//     credentials: true,
//     allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'device-remember-token', 'Access-Control-Allow-Origin', 'Origin', 'Accept']
// }

app.use(cors());
// app.enable('trust proxy')

let receiverPCs = {}
let senderPCs = {}
let users = {}
let socketToRoom = {}
// let socketIDMap = {}

const pc_config = {
    iceServers: [
        // {
        //     urls: [
        //         "stun:stun.l.google.com:19302",
        //         "stun:stun1.l.google.com:19302",
        //         "stun:stun2.l.google.com:19302",
        //         "stun:stun3.l.google.com:19302",
        //         "stun:stun4.l.google.com:19302",
        //       ],
        // },
        {
            "username":"u-SD8l77k-U-ItC6MMVo1aoAOHVCcmZOIHbHrfiRLkOsw1GF_J-uILRGV7TAGUYpAAAAAGOQon1yb2JpbmpvbzEwMTU=",
            "urls":[
              "stun:ntk-turn-1.xirsys.com",
              "turn:ntk-turn-1.xirsys.com:80?transport=udp",
              "turn:ntk-turn-1.xirsys.com:3478?transport=udp",
              "turn:ntk-turn-1.xirsys.com:80?transport=tcp",
              "turn:ntk-turn-1.xirsys.com:3478?transport=tcp",
              "turns:ntk-turn-1.xirsys.com:443?transport=tcp",
              "turns:ntk-turn-1.xirsys.com:5349?transport=tcp"
            ],
            "credential":"15c61834-763b-11ed-8083-0242ac120004"
          }
    ]
}

const isIncluded = (array, id) => array.some((item) => item.id === id)

const createReceiverPeerConnection = async (socketID, socket, roomID) => {
    console.log('createReceiverPeerConnection', socketID, roomID)

    const pc = await new wrtc.RTCPeerConnection(pc_config)

    console.log('new receiver pc created', socketID)

    pc.onicecandidate = async(e) => {
        console.log(`socketID: ${socketID}'s receiverPeerConnection icecandidate`, e.candidate)
        // if (!e.candidate) return;
        const timer = ms => new Promise(res => setTimeout(res, ms))
        while(receiverPCs[socketID].localDescription === null) {
            await timer(1)
        }
        socket.to(socketID).emit("getSenderCandidate", {
            candidate: e.candidate
        })
        console.log("emitted getSenderCandidate", socketID)
    }

    pc.oniceconnectionstatechange = (e) => {
        console.log("ReceiverPeerConnection IceConnectionStateChange", pc.iceConnectionState, socketID)
    }

    pc.ontrack = (e) => {
        console.log('receiver pc ontrack')
        if (users[roomID]) {
            if (!isIncluded(users[roomID], socketID)) {
                users[roomID].push({
                    id: socketID,
                    stream: e.streams[0],
                })
            } else return
        } else {
            users[roomID] = [
                {
                    id: socketID,
                    stream: e.streams[0],
                }
            ]
        }
        socket.broadcast.to(roomID).emit("userEnter", { id: socketID })
        console.log("emitted userEnter", socketID)
    }

    receiverPCs[socketID] = pc
    // socketIDMap[socket.id] = socketID

    return pc
}

const createSenderPeerConnection = async (
    receiverSocketID,
    senderSocketID,
    socket,
    roomID
) => {
    console.log("createSenderPeerConnection", senderSocketID, receiverSocketID)
    const pc = await new wrtc.RTCPeerConnection(pc_config)

    console.log('new sender pc created', senderSocketID, receiverSocketID)

    pc.onicecandidate = async(e) => {
        console.log(`socketID: (${receiverSocketID})'s senderPeerConnection icecandidate`)
        // if (!e.candidate) return;
        const timer = ms => new Promise(res => setTimeout(res, ms))
        while(pc.localDescription===null) {
            await timer(1)
        }
        socket.to(receiverSocketID).emit("getReceiverCandidate", {
            id: senderSocketID,
            candidate: e.candidate,
        })
        console.log("emitted getReceiverCandidate", senderSocketID, receiverSocketID)
    }

    pc.oniceconnectionstatechange = (e) => {
        console.log("SenderPeerConnection IceConnectionStateChange", pc.iceConnectionState, receiverSocketID, senderSocketID)
    }

    const sendUser = users[roomID].filter((user) => user.id === senderSocketID)[0]
    await sendUser.stream.getTracks().forEach((track) => {
        pc.addTrack(track, sendUser.stream)
    })
    console.log('sender pc addtrack')
    
    if (senderPCs[senderSocketID]) {
        // senderPCs[senderSocketID].filter((user) => user.id !== receiverSocketID)
        senderPCs[senderSocketID].push({ id: receiverSocketID, pc })
    } else {
        senderPCs = {
            ...senderPCs,
            [senderSocketID]: [{ id: receiverSocketID, pc }],
        }
    }
    console.log("senderPC saved")

    return pc
}

const getOtherUsersInRoom = (socketID, roomID) => {

    let allUsers = []

    if (!users[roomID]) return allUsers

    allUsers = users[roomID]
        .filter((user) => user.id !== socketID)
        .map((otherUser) => ({ id: otherUser.id }))

    return allUsers
}

const deleteUser = (socketID, roomID) => {
    console.log("deleteUser", socketID, roomID)

    if (!users[roomID]) return
    
    users[roomID] = users[roomID].filter((user) => user.id !== socketID)
    if(users[roomID].length === 0) {
        delete users[roomID]
    }
    delete socketToRoom[roomID]
}

const closeReceiverPC = async (socketID) => {
    console.log("closeReceiverPC", socketID)

    if (!receiverPCs[socketID]) return

    // console.log("closeReceiverPC", receiverPCs[socketID])

    // receiverPCs[socketID].close()
    // ?? doesn't continue 
    // 1. already closed in closed client? -> nothing to close (no ack)

    delete receiverPCs[socketID]
    // console.log("closeReceiverPCs deleted")
}

const closeSenderPCs = (socketID) => {
    console.log("closeSenderPCs", socketID)

    if (!senderPCs[socketID]) return

    try {
        senderPCs[socketID].forEach((senderPC) => {
            senderPC.pc.close()
            const eachSenderPC = senderPCs[senderPC.id].filter(
                (sPC) => sPC.id === socketID
            )[0]
            if (!eachSenderPC) return
            eachSenderPC.pc.close()
            senderPCs[senderPC.id] = senderPCs[senderPC.id].filter(
                (sPC) => sPC.id !== socketID
            )
        })
    } catch (e) {
        console.log(e)
    }

    try {
        delete senderPCs[socketID]
    } catch (e) {
        console.log(e)
    }
}

// const io = socketio.listen(server); // ?

io.on("connection", (socket) => {
    console.log(socket.id, 'on connection')

    socket.on("joinRoom", (data) => {
        console.log('on joinRoom', data.id)
        try {
            let allUsers = getOtherUsersInRoom(data.id, data.roomID)
            io.to(data.id).emit("allUsers", {users: allUsers})
            console.log("emitted allUsers", data.id, allUsers)
        } catch (error) {
            console.log(error)
        }
    })

    socket.on("senderOffer", async (data) => {
        console.log("on senderOffer", data.senderSocketID)
        try {
            socketToRoom[data.senderSocketID] = data.roomID;
            let pc = await createReceiverPeerConnection(
                data.senderSocketID,
                socket,
                data.roomID
            ) // already saved pc in array (*modified)

            // await pc.setRemoteDescription(data.sdp) // (pc use x)
            await receiverPCs[data.senderSocketID].setRemoteDescription(data.sdp) // access saved array element
            await console.log("senderOffer setRemoteDescription")

            let sdp = await pc.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            })
            // await pc.setLocalDescription(sdp) // (pc use x)
            await receiverPCs[data.senderSocketID].setLocalDescription(sdp) // access saved array element
            await console.log("senderOffer setLocalDescription")

            // receiverPCs[data.senderSocketID] = await pc // save in createReceiverPeerConnection function
            // await console.log("receiverPC saved")

            await socket.join(data.roomID)
            console.log('joined room', data.senderSocketID, data.roomID)
            await io.to(data.senderSocketID).emit("getSenderAnswer", { sdp })
            console.log("emitted getSenderAnswer", data.senderSocketID)
        } catch (error) {
            console.log(error)
        }
    })

    socket.on("senderCandidate", async (data) => {
        console.log("on senderCandidate", data.senderSocketID)
        try {
            /*
            // let pc = receiverPCs[data.senderSocketID]
            // await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate))
            */ // error
            const timer = ms => new Promise(res => setTimeout(res, ms))
            while (!receiverPCs[data.senderSocketID]) {
                await timer(1)
            }
            while (receiverPCs[data.senderSocketID].localDescription === null) {
                await timer(1)
            }

            await receiverPCs[data.senderSocketID].addIceCandidate(await new wrtc.RTCIceCandidate(data.candidate))
            console.log('senderCandidate addIceCandidate receiverPC', data.senderSocketID)
        } catch (error) {
            // console.log('senderCandidate error')
            console.log(error);
        }
    })

    socket.on("receiverOffer", async (data) => {
        console.log("on receiverOffer", data.senderSocketID, data.receiverSocketID)
        try {
            let pc = await createSenderPeerConnection(
                data.receiverSocketID,
                data.senderSocketID,
                socket,
                data.roomID
            )
            pc = await senderPCs[data.senderSocketID].filter((user)=>user.id==data.receiverSocketID)[0].pc
            await pc.setRemoteDescription(data.sdp)
            console.log('receiverOffer setRemoteDescription', data.senderSocketID, data.receiverSocketID)
            let sdp = await pc.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            })
            await pc.setLocalDescription(sdp)
            console.log('receiverOffer setLocalDescription', data.senderSocketID, data.receiverSocketID)
            io.to(data.receiverSocketID).emit("getReceiverAnswer", {
                id: data.senderSocketID,
                sdp: sdp
            })
            console.log("emitted getReceiverAnswer", data.receiverSocketID, data.senderSocketID)
        } catch (error) {
            console.log(error)
        }
    })

    socket.on("receiverCandidate", async (data) => {
        console.log("on receiverCandidate", data.senderSocketID, data.receiverSocketID)
        try {
            const timer = ms => new Promise(res => setTimeout(res, ms))
            while (!senderPCs[data.senderSocketID]) {
                await timer(1)
            }
            while (senderPCs[data.senderSocketID].filter((sPC)=>sPC.id===data.receiverSocketID).length === 0) {
                await timer(1)
            }
            while (senderPCs[data.senderSocketID].filter((sPC) => sPC.id === data.receiverSocketID)[0].pc.localDescription === null) {
                await timer(1)
            }

            const senderPC = await senderPCs[data.senderSocketID].filter( // error
                (sPC) => sPC.id === data.receiverSocketID
            )[0].pc
            await senderPC.addIceCandidate(
                await new wrtc.RTCIceCandidate(data.candidate)
            )
            console.log('receiverCandidate addIceCandidate senderPC', data.receiverSocketID)
        } catch (error) {
            console.log(error)
        }
    })
    
    socket.on("disconnect", () => {
        try {
            // let socketID = socketIDMap[socket.id]
            let socketID = socket.id
            let roomID = socketToRoom[socketID]
            // let roomID = socketToRoom[socket.id]
            
            console.log("disconnect", socketID, roomID)

            // deleteUser(socket.id, roomID)
            deleteUser(socketID, roomID)
            // console.log("disconnect deleteUser executed")

            // closeSenderPCs(socket.id)
            closeSenderPCs(socketID)
            // console.log("disconnect closeSenderPCs executed")

            // closeReceiverPC(socket.id)
            socket.disconnect()
            // console.log("disconnect socket disconnected")

            closeReceiverPC(socketID)
            // console.log("disconnect closeReceiverPC executed")

            // socket.broadcast.to(roomID).emit("userExit", {id: socket.id})
            socket.broadcast.to(roomID).emit("userExit", {id: socketID})
            // console.log("emitted userExit", socket.id)

        } catch (error) {
            console.log(error)
        }
    })
})

server.listen(process.env.PORT || 8080, () => {
    console.log("server running on port 8080!")
})