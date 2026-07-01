module.exports = {
      PORT: process.env.PORT || 2309,
  WS_PORT: process.env.WS_PORT || 2309,
  // WhatsApp bug types
  BUGS: [
    { bug_id: "ios", bug_name: "FC IOS" },
    { bug_id: "delay", bug_name: "DELAY INVIS" },
    { bug_id: "click", bug_name: "FC CLICK" },
    { bug_id: "freze", bug_name: "FREZE CHAT" },
    { bug_id: "blank", bug_name: "BLANK STUCK" },
    { bug_id: "spam", bug_name: "DELAY SPAM"},
    { bug_id: "buldo", bug_name: "SEDOT KUOTA" },
    { bug_id: "andro", bug_name: "FC ANDRO" }
  ],

  payload: [
    { bug_id: "invisibleSpam", bug_name: "DELAY ANDROID" },
    { bug_id: "forceCloseMentalVVIP", bug_name: "FORCE CLOSE" },
    { bug_id: "stealthCrashVVIP", bug_name: "CRASH ANDROID" },
    { bug_id: "crashNotificationVVIP", bug_name: "CRASH NOTIFIKASI" },
    { bug_id: "permenCall", bug_name: "PRANK CALL" }
  ],
  
  tqto: [
        {
            name: "Sanzope",
            status: "Developer, ceo paling ganteng sedunia",
            ppUrl: "https://files.catbox.moe/kzcm7v.jpg",
            contac: "t.me/sanzope"
        },
        {
            name: "ニ Xatanical",
            status: "Support sanz adalah staf dari Xatanical",
            ppUrl: "https://files.catbox.moe/nfu1pi.jpg",
            contac: "t.me/Xatanicvxii"
        },
        
    ],
    
  DDOS: [
    { ddos_id: "s-gbps", ddos_name: "SYN High GBPS" },
    { ddos_id: "s-pps", ddos_name: "SYN Traffic Flood" },
    { ddos_id: "a-gbps", ddos_name: "ACK High GBPS" },
    { ddos_id: "a-pps", ddos_name: "ACK Traffic Flood" },
    { ddos_id: "icmp", ddos_name: "ICMP Flood" },
    { ddos_id: "udp", ddos_name: "GUDP ( HIGH RISK )" }

  ],
  // News data - 2 items
  NEWS: [
    {
      image: "https://files.catbox.moe/rkxxie.jpg",
      title: "LAWLIET",
      desc: "DEVELOPER @chicaatractiva"
    },
    {
      image: "https://files.catbox.moe/rkxxie.jpg",
      title: "LAWLIET",
      desc: "UP ROLE PV @chicaatractiva"
    }
  ],
  // Role cooldowns (in seconds)
  ROLE_COOLDOWNS: {
    member: 300,
    partner: 240,
    partner1: 60,
    moderator: 0,
    reseller: 60,
  },
  // Max quantities by role
  MAX_QUANTITIES: {
    member: 5,
    partner: 5,
    partner1: 5,
    moderator: 10,
    reseller: 10,
  }
};