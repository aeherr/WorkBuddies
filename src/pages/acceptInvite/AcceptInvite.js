// eslint-disable-next-line no-unused-vars
import React, { useState, useContext, useEffect } from 'react';
import styles from './AcceptInvite.module.css'
import { FirebaseContext } from '../../firebaseComponents'
import { ROUTES } from 'wb-utils/constants'
import { Alert, Spinner, Modal, Button } from 'react-bootstrap'
import SignUpForm from '../../shared/signUpForm/SignUpForm';
import icon from '../../assets/images/single_matchup_icons.svg'
import acceptInvite from 'wb-utils/acceptInvite'
import { TrackingContext } from '../../tracking'

const AcceptInvite = ({ history, location }) => {
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [suggestedEmail, setSuggestedEmail] = useState()
  const [invites, setInvites] = useState(null)
  const [inviteFromLink, setInviteFromLink] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [accountInfo, setAccountInfo] = useState(null)
  const firebase = useContext(FirebaseContext)
  const tracking = useContext(TrackingContext)

  useEffect(() => {
    let id = new URLSearchParams(location.search).get('id') || localStorage.getItem('inviteId')
    if(id) {
      firebase.db.collection('invites').doc(id).get()
      .then(snapshot => {
        if(snapshot && snapshot.exists) {
          setInviteFromLink(snapshot)
          localStorage.setItem('inviteId', id)
          if(snapshot.data().email) {
            setSuggestedEmail(snapshot.data().email)
          }
        } else {
          localStorage.removeItem('inviteId')
        }
        setReady(true)
      }).catch(_error => {
        setReady(true)
        setError('Sorry! Your invite link has expired. ')
      })
    } else {
      setReady(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openSelectInvite = (docs, accountInfo) => {
    setInvites(null)
    let promises = []
    docs.forEach(invite => {
      if(!invite.data() || !invite.data().company_uid) return
      promises.push(
        firebase.db.collection('companies').doc(invite.data().company_uid).get()
        .then(snapshot => {
          let id = invite.id
          let result = invite.data()
          result.company = snapshot.data()
          result.id = id
          return result
        })
      )
    })
    Promise.all(promises)
    .then(results => {
      results = results.filter(invite => invite && invite.company)
      if(results.length === 0) {
        return updateError("Sorry! We couldn't find any invites for that email address.")
      } else if(results.length === 1) {
        let invite = results[0]
        acceptInvite(invite.data().company_uid, invite.id, accountInfo)
      } else {
        setInvites(results)
        setShowModal(true)
      }
    })
  }

  const findAssociatedInvites = ({ email }) => {
    return firebase.db.collection('invites').where('email', '==', email).get()
      .then(snapshot => {
        let results = snapshot.docs || []
        if(inviteFromLink) {
          results = results.filter(invite => invite.id !== inviteFromLink.id)
          results.push(inviteFromLink)
        }
        return results
      })
  }

  const acceptInviteHandler = async (companyId, inviteId, info = accountInfo) => {
    acceptInvite(firebase, companyId, inviteId, info)
    .then(() => {
      tracking.signIn()
      history.push(ROUTES.BASE)
    })
    .catch(error => {
      updateError(error)
      return Promise.reject(error)
    })
  }

  const onSubmit = async (accountInfo) => {
    setError(null)
    setLoading(true)
    setAccountInfo(accountInfo)
    let emailExists = await firebase.doesUserExistForEmail(accountInfo.email)
    if (emailExists) return updateError('Sorry! There is already an account for that email address.')
    let invites = await findAssociatedInvites(accountInfo)
    if(!invites || invites.length === 0) return updateError("Sorry! We couldn't find any invites for that email address. Please enter an email address associated with an invite, or follow the link provided in the invite.")
    else if(invites.length === 1) {
      let invite = invites[0]
      return acceptInviteHandler(invite.data().company_uid, invite.id, accountInfo)
    } else {
      openSelectInvite(invites, accountInfo)
    }
  }

  const updateError = (error) => {
    setShowModal(false)
    setError(error)
    setLoading(false)
  }

  const closeModal = () => {
    setShowModal(false)
    setLoading(false)
  }


  if (!ready) return (<Spinner animation="border" size="lg" variant="primary"/>)
  return (
    <div className={styles.outerWrapper}>
      <div className={styles.wrapper}>
        <h3 className={styles.title}>You’re invited to Work Buddies! <br/> Let’s set up your account</h3>
        {
          error ? <Alert variant="danger" className={styles.alert}>{ error }</Alert> : null
        }
        <SignUpForm onSubmit={onSubmit} loading={loading} suggestedEmail={suggestedEmail}/>

      <Modal show={showModal} onHide={closeModal}>
          <Modal.Header closeButton>
            <Modal.Title>Please select the company you would like to join.</Modal.Title>
          </Modal.Header>

          <Modal.Body>
            {
              invites ?
                invites.map(invite => {
                return (
                  <div key={invite.id} className={styles.selectCompany}>
                    <Button
                      onClick={() => acceptInviteHandler(invite.company_uid, invite.id)}>
                      {invite.company.name}
                    </Button>
                  </div>
                )})
                : "Fetching all invites..."
            }
          </Modal.Body>
        </Modal>
      </div>
      <div className={styles.iconWrapper}>
        <div className={styles.subtitle}>Get to know your co-workers, one activity at a time. </div>
        <img src={icon} alt="Co-workers pairing up for an activity" className={styles.icon} />
      </div>
    </div>
  );
}

export default AcceptInvite
