// The Cloud Functions for Firebase SDK to create Cloud Functions and setup triggers.
const functions = require('firebase-functions');
const sgMail = require('@sendgrid/mail');
const moment = require('moment-timezone');
const initQueries = require('./queries.js');
const uuidv1 = require('uuid/v1');
const { PubSub } = require('@google-cloud/pubsub');
const inviteEmailContent = require('./emails/invite.js')
// The Firebase Admin SDK to access the Firebase Realtime Database.
const admin = require('firebase-admin');
var serviceAccount = require("./admin-service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://work-buddies-2e620.firebaseio.com"
});

const config = functions.config()

const pubsub = new PubSub({
  projectId: process.env.GCLOUD_PROJECT,
  keyFilename: './admin-service-account.json'
});

console.log(config.mail)
sgMail.setApiKey(config && config.mail ? config.mail.key : "");
sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally

//Delete all invites for an email when a user joins
exports.inviteAccepted = functions.firestore.document('users/{userId}')
  .onCreate((userSnapshot, _ctx) => {
    const firestore = admin.firestore();
    const invitesRef = firestore.collection('invites');
    let email = userSnapshot.data().email

    return invitesRef.where('email', '==', email).get()
    .then(snapshot => {
      var batch = firestore.batch()

      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref)
      })
      return batch.commit()
    })
  })

//INVITE EMAIL
const getFromEmail = () => {
  return config && config.mail ? config.mail.email : 'annadesiree11@gmail.com'
}

const signupLink = `${config && config.host && typeof config.host == 'string' ? config.host : 'http://localhost:3000'}/signup`



exports.inviteHandler = functions.firestore.document('invites/{inviteId}')
  .onCreate((inviteSnapshot, _ctx) => {
    const firestore = admin.firestore();
    const adminRef = firestore.collection('users');
    const data = inviteSnapshot.data()

    return adminRef.doc(data.invitedBy).get().then(results => {
      let admin = results.data();

      let emailContent = inviteEmailContent()
      let link = `${signupLink}?id=${encodeURIComponent(inviteSnapshot.id)}`
      emailContent = emailContent.replace('{{link}}', link);
      if(inviteSnapshot.data().name) {
        emailContent = emailContent.replace('{{greeting}}', `Hi ${inviteSnapshot.data().name},`)
      } else {
        emailContent = emailContent.replace('{{greeting}}', 'Hi,')
      }
      emailContent = emailContent.replace('{{admin_name}}', admin.firstName);

      const msg = {
        to: inviteSnapshot.data().email,
        from: getFromEmail(),
        subject: 'You\'re Invited to Work Buddies!',
        html: emailContent,
      };

      return sgMail.send(msg);
    });
  });

  //END INVITE EMAIL



//GENERATE MATCHUPS
const getLastBuddy = (userId, previousMatchups) => {
  if(!previousMatchups) return false
  let matchup = previousMatchups.find(matchup => {
    return matchup.buddies.indexOf(userId) !== -1
  })
  if(matchup && matchup.buddies.length === 2) {
    let userIndex = matchup.buddies.indexOf(userId)
    return userIndex === 0 ? matchup.buddies[1] : matchup.buddies[0]
  }
  return false

}

const getRandom = (collection) => {
  if(!collection || collection.length === 0) return null
  return collection[Math.floor(Math.random()*collection.length)]
}

const buddyEmail = "Hello {{buddy1}},<br/><br/> You have been matched up with {{buddy2}} as Work Buddies this week! {{activityString}} <br/> <br/> Sincerely,<br/> the Work Buddies Team"
const noBuddyEmail = "Hello {{buddy1}},<br/><br/> Unfortunately there is an odd number of people in your group, so you did not get matched up with a buddy this week. Please check back next week for your new matchup. <br/><br/> Sincerely,<br/> the Work Buddies Team"

const addEmailPersonalization = (buddy1, buddy2, activity, emailInfo) => {
  if (!buddy1 || !buddy1.email || !buddy1.notifyEmail) return null
  let to = [{email: buddy1.email}]
  let activityString = activity ? `Your activity this week is ${activity.name}. Don't like the suggested activity? That's okay! You and your buddy can do whatever you'd like, as long as you spend a few minutes together this week.` : "Talk with your buddy and pick something around the office to do this week. We recommend grabbing a coffee or going for a walk."
  let substitutions = {"buddy1": `${buddy1.firstName} ${buddy1.lastName}`, "activityString": activityString }
  if (buddy2) {
    substitutions["buddy2"] = `${buddy2.firstName} ${buddy2.lastName}`
  }

  return emailInfo.push({ to, substitutions, subject: "Your Weekly Buddy" })
}

const notify = (buddy1, buddy2, activity, emailInfo) => {
  if (!buddy1) return null
  addEmailPersonalization(buddy1, buddy2, activity, emailInfo)
  return null
}

const getOddManOutIndex = (previousMatchups, users) => {
  let single = previousMatchups.find(matchup => {
    return matchup.buddies && matchup.buddies.length === 1
  })
  if (!single) return -1
  let singleId = single.buddies[0]

  let oddManOut = users.findIndex(user => {
    return user.id === singleId
  })
  return oddManOut
}

const matchup = async (data) => {
  const companyId = data.id
  let eventId = data.event_id || uuidv1()

  const firestore = admin.firestore();
  let companyRef = firestore.collection('companies').doc(companyId);
  if (!companyRef) return Promise.reject(new Error("company not found"))


  let existingMatchup = await companyRef.collection('buddies').doc(eventId)
  if(existingMatchup.exists) return Promise.reject(new Error('duplicate matchup event'))

  await companyRef.collection('buddies').doc(eventId).set({ loading: true })

  let companyData = await companyRef.get()
  companyData = companyData.data()
  let activitiesSnapshot = await companyRef.collection('activities').get()

  const activities = []
  activitiesSnapshot.forEach(doc => activities.push(doc.data()))

  let usersRef = firestore.collection('users').where('company_uid', '==', companyId)
  let lastBuddiesRef = companyData.activeBuddies ? await companyRef.collection('buddies').doc(companyData.activeBuddies) : null
  let lastBuddiesDoc = lastBuddiesRef  ? await lastBuddiesRef.get() : false
  let previousMatchups = lastBuddiesDoc && lastBuddiesDoc.exists  ? await lastBuddiesDoc.data().matchups : []

  let newMatchups = []
  let emailInfo = []
  let emailPromises = []

  let matchUpUsersPromise = usersRef.get()
    .then(async snapshot => {
      const users = []
      snapshot.forEach(user => users.push(user))

      // If someone wasn't matched up last time, match them first this time
      let oddManOutIndex = getOddManOutIndex(previousMatchups, users)
      while (users.length > 1) {
        let buddy = null
        let user = null
        if(oddManOutIndex >=0 && oddManOutIndex < users.length) {
          user = users[oddManOutIndex]
          users.splice(oddManOutIndex, 1)
          oddManOutIndex = -1
        } else {
          user = users.pop()
        }
        if(users.length === 1) {
          buddy = users.pop()
        } else {
          const usersCopy = [...users].map((user, i) => {
            let data = {}
            data.id = user.id
            data.originalIndex = i
            return data
          })
          let lastBuddyId = getLastBuddy(user.id, previousMatchups)
          if(lastBuddyId) {
            //remove last buddy from array of options
            let lastBuddyIndex = usersCopy.findIndex(user => user.id === lastBuddyId)
            usersCopy.splice(lastBuddyIndex, 1)
          }

          //get random buddy from remaining options
          let buddyInfo = getRandom(usersCopy)

          //remove buddy from original users list
          buddy = users[buddyInfo.originalIndex]
          users.splice(buddyInfo.originalIndex, 1)

        }
        let activity = getRandom(activities)

        //buddy 1 notifications
        let userData = user ? user.data() : null
        let buddyData = buddy ? buddy.data() : null
        notify(userData, buddyData, activity, emailInfo)

        //buddy2 notifications
        notify(buddyData, userData, activity, emailInfo)

        newMatchups.push({
          buddies: [user.id, buddy.id],
          activity: activity
        })
      }
      // end of matching up loop


      let allMessages = []
      //Handle emails with buddies
      if (emailInfo.length) {
        let msg = {
          personalizations: emailInfo,
          from: getFromEmail(),
          html: buddyEmail
        }
        allMessages.push(msg)
      }


      if(users.length === 1) {
        //handle odd
        let activity = getRandom(activities)
        user = users.pop()
        newMatchups.push({
          buddies: [user.id],
          activity: activity
        })
        let userData = user.data()
        if(userData.notifyEmail) {
          let emailInfo = []
          addEmailPersonalization(userData, null, activity, emailInfo)
          let msg = {
            personalizations: emailInfo,
            from: getFromEmail(),
            html: noBuddyEmail
          }
          allMessages.push(msg)
        }
      }

      //double check existing matchup
      let existingMatchup = await companyRef.collection('buddies').doc(eventId).get()
      if (existingMatchup && !existingMatchup.data().loading) return null

      emailPromises = allMessages.forEach(msg => sgMail.send(msg))
      // eslint-disable-next-line promise/no-nesting
      return companyRef.collection('buddies').doc(eventId).set({
        matchups: newMatchups
      })
      .then(_snapshot => {
        return companyRef.set({
          activeBuddies: eventId
        }, {merge: true})
      })
    })

    let setNextMatchupPromise = setNextMatchupTime(companyId)

    return Promise.all([matchUpUsersPromise, setNextMatchupPromise].concat(emailPromises))
}

exports.matchupSub = functions.pubsub.topic('matchup').onPublish((message, _ctx) => {
  const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
  console.info(JSON.stringify(data))
  return matchup(data)
})

exports.matchup = functions.https.onCall((data, _ctx) => {
  return matchup(data)
})
// END GENERATE MATCHUPS


// TRIGGER MATCHUPS

//set next matchup time
const setNextMatchupTime = (companyId) => {
  const firestore = admin.firestore();
  let companyRef = firestore.collection('companies').doc(companyId);
  if (!companyRef) return Promise.reject(new Error("company not found"))

  return companyRef.get()
  .then(company => {
    let data = company.data()
    let now = moment().tz(data.timeZone)
    let nextTime = moment().tz(data.timeZone).isoWeekday(data.day).hour(data.hour).minute(0).second(0).milliseconds(0)

    if(now.isAfter(nextTime)) {
      nextTime = nextTime.add(1, 'weeks')
    }

    return company.ref.set({
      matchUpTime: nextTime.valueOf()
    }, {merge: true})
  })
}
exports.setNextMatchupTime = functions.https.onCall(({ companyId }, _ctx) => {
  return setNextMatchupTime(companyId)
})

exports.setInitialMatchupTime = functions.firestore.document('companies/{companyId}')
.onCreate((snapshot, _context) => {
  setNextMatchupTime(snapshot.id)
});


//find matchups happening this hour
const queries = initQueries(admin.firestore());
let publishToTopic = topic =>
  batch =>
    batch.forEach(v => {
      let event_id = uuidv1();
      let iso = new Date().toISOString();
      console.info(`[${iso}] Publishing to topic: '${topic}'`);
      console.info(`[${iso}] Event ID: ${event_id}`);
      return pubsub.topic(topic).publish(
        Buffer.from(JSON.stringify({
          id: v.id,
          event_id
        }))
      )
        .then(r => {
          iso = new Date().toISOString();
          console.info(`[${iso}] Successful Publish.`);
          console.info(`[${iso}] Event ID: ${event_id}`);
          console.info(`[${iso}] Message ID: ${r}`);
          return
        })
        .catch(e => {
          iso = new Date().toISOString();
          console.info(`[${iso}] Publish Failed.`);
          console.info(`[${iso}] Event ID: ${event_id}`);
          console.info(`[${iso}] Error: ${e.message}`);
        });
    });


exports.matchUpScheduler = functions.pubsub.schedule('*/5 * * * *').onRun((_ctx) => {
  let timestamp = moment.utc().valueOf();
  return queries.getToMatchUp(timestamp).asyncMap(publishToTopic('matchup'))
});

// END TRIGGER MATCHUPS
