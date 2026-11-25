'use strict';
// Each row pairs a distinct interview question with the behaviors the reviewer should look for.
const groups = {
'Motivation and commitment':`Why do you want to administer RAYMON BOT?|Connect motivation to a concrete user need
Which routine support task would you willingly own?|Describe the task and a sustainable routine
What would success in your first month look like?|Define an observable outcome and how to check it
What would make you decline an admin appointment?|Identify a realistic conflict and communicate honestly
How would you stay engaged during quiet shifts?|Identify useful preparation without creating unnecessary work
Which part of the portal would you learn first and why?|Explain user impact and a learning plan
What attracts you to helping users privately?|Discuss confidentiality and patient support
How would you respond if your first idea were declined?|Seek feedback and adapt constructively
What does earning community trust mean to you?|Describe consistent actions and accountability
How would you contribute without a public badge?|Describe service independent of recognition
Which personal habit would help you finish cases?|Explain a tracking and follow-up routine
What responsibility would initially stretch your skills?|Identify a limit and a path to competence
Why should the Founder select you?|Support a role-relevant claim with an example
What feedback would you seek after your first shift?|Choose specific feedback and use it to improve
How would you handle repetitive deployment questions?|Show patience and improve reusable guidance
Which community problem motivates you most?|Define the problem and a practical contribution
How would you recover enthusiasm after a difficult case?|Describe sustainable recovery and continuity
What promise would you make to a user waiting for help?|Set an honest and achievable expectation
What would you learn from shadowing a senior admin?|Identify an observable skill and practice method
How would you recognize your own improvement?|Choose evidence beyond ticket count
What keeps you accountable when working independently?|Explain checkpoints and documented outcomes
What would you do if the role differed from your expectations?|Clarify responsibilities and raise concerns early
How would you make a small improvement without extra permissions?|Identify a permitted action and a feedback loop
What does fair service to free users mean to you?|Explain equitable treatment within published benefits
What contribution could you sustain over three months?|Describe a realistic commitment and fallback`,
'Previous experience':`Describe a time you helped someone learn a tool.|Explain the steps and how understanding was confirmed
Tell us about a mistake you corrected.|Take responsibility and describe the correction
Describe experience moderating a disagreement.|Explain de-escalation and outcome
What support experience transfers from outside tech?|Connect an example to a portal duty
Describe a time you asked someone senior for help.|Identify the limit and escalation details
When have you managed a queue of requests?|Describe prioritization and follow-up
Describe a difficult handover.|Explain what information mattered
When did you change your mind after new evidence?|Identify the evidence and resulting action
Describe a useful guide you wrote or explained.|Explain the audience and feedback
Tell us about spotting a misleading instruction.|Describe verification and correction
Describe a time you protected confidential information.|Explain the decision without revealing personal data
When did you work with an unreliable connection?|Describe continuity and communication
How have you supported a frustrated first-time user?|Explain tone and verification of resolution
Describe a task you finished after an interruption.|Show tracking and recovery
When did you disagree with a policy respectfully?|Explain the channel and outcome
Describe a decision you documented for others.|Identify what another person needed to know
When have you escalated an issue too late?|Explain the lesson and earlier trigger
Describe a time you trained a teammate.|Give a concrete exercise and feedback method
When did you notice a recurring support issue?|Explain how you established the pattern
Describe managing expectations around a delayed fix.|Show honest updates and follow-through
Describe a time a user corrected your explanation.|Explain how the correction was checked
Tell us about sharing credit for a team result.|Identify others’ contributions
What did you learn from an unsuccessful project?|Connect a specific lesson to future behavior
Describe a responsibility you handled without a formal title.|Give a concrete example of initiative
If this is your first admin role, what experience prepares you?|Use relevant everyday or volunteer examples`,
'User support and complaints':`A user says their bot is silent. What do you ask first?|Gather command, time and connection context
A user disputes a coin deduction. How do you investigate?|Check ledger and renewal timing before promising credit
How would you respond to an angry first message?|Acknowledge impact and ask a focused question
What do you do when two users claim the same payment?|Verify transaction records privately and escalate ambiguity
How would you help a user who cannot find their case?|Locate the case through authenticated support
A user shares a password in chat. How do you respond?|Avoid copying it and direct them to change it
A user complains their VIP badge disappeared. What do you check?|Review membership tier and expiry
How would you explain a reapplication cooldown?|Give the applicable rule and next eligible time
A complaint concerns a senior admin. Where should it go?|Use independent private review
How do you handle an unclear screenshot?|Ask for minimal relevant details and redaction
What happens when the requester’s bot disconnects mid-case?|Continue the same case via the support number and explain the switch
A user wants another person’s ticket details. What do you say?|Protect confidentiality and offer an appropriate alternative
How do you confirm a fix worked for the reporter?|Ask for a targeted retry and record the outcome
How would you support someone unfamiliar with desktop mode?|Use mobile-friendly steps and verify their screen
What if the same issue is reported in three channels?|Link duplicates and keep one owner
How do you respond when a promised deadline slips?|Explain verified status and agree a next update
How do you handle abusive language in a support case?|Set boundaries while maintaining a route to help
A user requests an immediate refund. How do you respond?|Check evidence and authorized decision process
How would you help someone without a linked number recover access?|Keep pending until alternate verification is completed
A user reports another member impersonating staff. What next?|Verify identity through official portal records
How do you explain a pending WhatsApp notification?|Distinguish queued, sent and confirmed states
What if a user cannot reproduce a timeout?|Record environment and a reproducible observation
A user says their promo code failed. What do you check?|Verify eligibility, expiry and redemption state
How do you communicate uncertainty about a failure?|Distinguish observations from hypotheses
How would you handle a support request in a public group?|Move private details to a verified private channel
A user asks you to ignore a queue. How do you respond?|Apply published priority rules consistently
How do you close a case with unresolved dependencies?|Document the blocker and arrange ownership or follow-up
What would you say to a user whose screenshot upload failed?|Check format and size and offer text reporting
How would you correct an inaccurate public support answer?|Publish an accurate correction without exposing the reporter
How would you summarize a long complaint before acting?|Confirm issue, desired outcome and key evidence`,
'Problem-solving':`The portal loads but WhatsApp commands fail. How do you isolate the issue?|Separate portal health from worker and session health
How would you investigate a spike in failed deliveries?|Group by time, session and failure class
A fix works until restart. What would you inspect?|Check persistence and startup behavior
How would you compare two plausible causes of a timeout?|Choose a small discriminating test
A deployment is healthy but users report failures. What evidence matters?|Test the normal user path and correlate reports
How would you investigate a missing bonus?|Check eligibility, time boundary and ledger
A user is charged twice after a retry. What should change?|Trace duplicate events and require idempotent processing
How do you distinguish one broken account from a platform outage?|Compare affected scope and shared dependencies
Storage approaches capacity again. What is the first safe action?|Measure usage and identify disposable data
What do you do when logs contain private session material?|Restrict exposure and escalate safe logging
A back button closes the portal on mobile. How do you reproduce it?|Record navigation sequence and browser state
How would you diagnose conflicting VIP expiry displays?|Compare stored timestamp, timezone and frontend conversion
What do you check when a release works for one tester only?|Verify audience rules and account eligibility
How do you investigate a report with the wrong timestamp?|Clarify timezone and use a bounded search window
How would you triage five failures after a rollout?|Check shared change and impact before individual fixes
A retry sends duplicate notifications. How would you verify the cause?|Trace persisted event IDs and acknowledgments
What would you do if an apparent fix risks losing sessions?|Prefer reversible diagnostics and escalate destructive steps
How do you decide when to roll back a release?|Use impact, known baseline and rollback feasibility
Why might two admins see different controls?|Check role permissions and account state
What would you check when an image loads on Wi-Fi only?|Compare asset size and request behavior
How would you investigate a delayed support reply?|Trace ticket save, outbox and WhatsApp delivery
An application count exceeds its limit. What race could explain it?|Identify concurrent checks and atomic enforcement
How would you test a fix on an older account?|Use compatible test data and verify migrations
How would you diagnose reports of a frozen dashboard?|Separate rendering stalls from slow network calls
A report contradicts the dashboard. How do you reconcile them?|Check freshness, evidence and timestamps
How would you handle intermittent reconnect loops?|Look for disconnect reason and preserve valid auth
When should you stop repeating a failed operation?|Set retry bounds and inspect the failure
How would you reduce noise during an incident?|Consolidate reports and share verified updates
What evidence belongs in a useful developer bug report?|Include reproduction, expected result and safe diagnostics
How do you know an incident is actually resolved?|Verify end-to-end behavior and observe recurrence`,
'Leadership and teamwork':`Two admins claim the same case. How should ownership be decided?|Use recorded assignment and coordinate handoff
How would you delegate during a busy shift?|Match authority and skills to tasks
How do you welcome a newly appointed Level 1 admin?|Explain scope and provide guided practice
A teammate skips documentation. How do you address it?|Explain impact privately and agree a routine
How do you hand off an unresolved incident?|Document owner, evidence, next action and deadline
How would you manage disagreement about a ban?|Review policy and escalate disputed judgment
A teammate is overwhelmed. How do you help?|Redistribute work with clear ownership
How do you lead a short incident review?|Focus on evidence, improvements and owners
When should a junior admin challenge a senior decision?|Raise material concerns through appropriate channels
How would you organize a beta feedback session?|Set scope and collect actionable observations
How would you communicate an urgent change to staff?|Use a clear channel and confirm receipt
How do you prevent repeated work across shifts?|Maintain searchable case state and handover notes
How would you praise good moderation publicly?|Recognize behavior without exposing case details
How do you manage a teammate who promises unauthorized rewards?|Correct the commitment and coach within permission limits
How would you resolve competing priorities from two supervisors?|Clarify authority, urgency and expected outcome
How do you make quieter team members heard?|Offer accessible feedback channels
How would you coordinate coverage for a launch?|Assign shifts, fallback contacts and escalation triggers
How would you support a trainee after an incorrect reply?|Correct the user impact and provide specific feedback
What makes a team decision record useful?|Capture evidence, decision, owner and review date
How do you share a lesson from a private ticket?|Remove identifying details and preserve the lesson
How would you organize a support shift with mixed experience?|Pair complementary skills and define escalation
How would you address unfair distribution of tickets?|Use workload evidence and rebalance assignments
How do you handle conflict between friends on staff?|Disclose relationships and use independent review
How would you measure whether training helped?|Compare observable task outcomes
How would you prepare someone to cover your duties?|Provide procedures, limits and practice`,
'Rules, ethics, and fairness':`A friend requests free coins. How do you respond?|Apply policy and disclose conflict
Can acceptance alone grant admin privileges?|Require separate authorized appointment
How do you protect an applicant’s private answers?|Limit access to authorized reviewers
A polished answer sounds AI-written. What evidence can you record?|Use verifiable portal events or self-disclosure only
How should a reviewer handle a relative’s application?|Disclose conflict and recuse where appropriate
A donor asks for special moderation treatment. What next?|Apply the same conduct rules
What would you do after granting coins by mistake?|Report and correct through audited processes
Why should staff avoid asking users for pairing codes?|Protect account access and use authorized verification
How do you balance transparency and privacy in an appeal?|Explain the decision without disclosing private records
A VIP member insults a free user. What rules apply?|Apply conduct standards consistently
What should happen when policy is unclear?|Pause consequential action and request clarification
How do you preserve evidence of staff misconduct?|Use authorized records and restrict access
A user asks to see another applicant’s score. What do you do?|Protect applicant confidentiality
Why should administrators use individual accounts?|Maintain accountability and role boundaries
How should you handle accidentally viewing private information?|Limit further access and report appropriately
When is it appropriate to share a screenshot internally?|Use a legitimate need and redact sensitive details
How would you respond to a bribe for promotion?|Decline, preserve evidence and escalate
Why keep a record of manual score changes?|Preserve original assessment and decision accountability
How can a reviewer avoid favoring polished English?|Score relevant evidence against the rubric
How should an admin handle a complaint about themselves?|Refer to independent review
What makes an enforcement decision proportionate?|Consider harm, policy and consistent precedent
Why respect notification consent during recruitment?|Honor user preferences and authorized messaging routes
How would you handle a request to erase an audit trail?|Decline and refer to retention authority
What is a fair response to an honest first-time mistake?|Apply policy and explain corrective steps
How do you handle an unverified accusation in community chat?|Avoid public judgment and gather evidence privately`,
'Technical knowledge and bot management':`What does a successful Railway build establish?|Distinguish build success from runtime and command delivery
What is a personal WhatsApp (You) chat used for in support?|Explain linked-account self-chat routing
What does a pairing code authorize?|Link a device and protect the code
Why store deployment sessions on persistent storage?|Preserve authentication across restarts
What does a storage write failure affect?|Identify session persistence and database risks
How does a bot command prefix affect troubleshooting?|Verify configured prefix and exact input
Why might a linked device show syncing?|Distinguish initial sync from verified readiness
What distinguishes a phone-number JID from a LID?|Use verified mapping without guessing a phone number
What should a deployment health check cover?|Check portal, worker and real command path
Why use a stable delivery ID for retries?|Correlate attempts and suppress duplicates
How does a worker know whether a bot may run?|Check authorization, lease and deployment state
Why avoid deleting SQLite files during cleanup?|Preserve user records and transactional data
How do you recognize a session that requires re-pairing?|Use explicit session rejection rather than generic timeout
What is the role of a database migration?|Change schema safely for existing records
Why do rate limits matter on public application endpoints?|Bound abuse and resource consumption
How should an API key be supplied to the portal?|Use server-side secret configuration
Why can an action be hidden but still unauthorized?|Enforce permissions on the server
What is a safe test for a new announcement feature?|Use an opted-in test recipient and verify delivery
How does a queued notification differ from a delivered notification?|Identify actual delivery evidence
Why preserve a round’s original rubric?|Ensure later reviews use the published version`,
'Availability and responsibility':`What weekly schedule can you reliably cover?|Specify realistic hours and timezone
How would you communicate an unexpected absence?|Notify the team and transfer open work
How much notice can you give before a planned break?|Describe practical notice and handoff
How do you balance studies or work with admin duties?|Set sustainable availability and boundaries
What would you do if your internet failed mid-case?|Arrange alternate contact and transfer ownership
How would you plan coverage around exams or travel?|Provide advance notice and backup coverage
What time zone should you use when promising an update?|State an explicit shared time zone
How do you decide whether to accept a case near shift end?|Assess time, urgency and handover options
How would you track follow-ups over several days?|Use case records and reminders
What would you do if you missed a promised update?|Acknowledge delay and set a realistic next time
How should you mark yourself unavailable?|Update availability and release outstanding duties
How do you avoid taking more cases than you can handle?|Limit concurrent work and communicate capacity
What would you check at the start of a shift?|Review handoffs, incidents and assigned cases
What belongs in an end-of-shift summary?|List open cases, risks, owners and next actions
When could you attend an interview or assessment?|Provide specific available windows with timezone
How would you handle an urgent alert outside your available hours?|Use escalation coverage and realistic boundaries
How would you prioritize a user waiting since yesterday?|Assess urgency and acknowledge waiting time
How should temporary cover receive access?|Use authorized limited permissions and expiry
How do you protect account access on a shared device?|Use individual login and sign out securely
When should you request a reduction in duties?|Recognize capacity limits early and arrange continuity`
};
module.exports=Object.entries(groups).flatMap(([category,rows],g)=>rows.split('\n').map((row,i)=>{
  const [prompt,criteria]=row.split('|');
  const difficulty=/investigate|conflict|two |incident|race |rollback|dispute|contradict/i.test(prompt)?'Advanced':/how|describe|when|why/i.test(prompt)?'Intermediate':'Basic';
  return {id:'Q'+(g+1)+'-'+String(i+1).padStart(2,'0'),category,prompt,criteria,difficulty,
    rubric:'50 points for addressing this criterion: '+criteria+'. 30 for a specific, feasible example or explanation; 20 for clear reasoning consistent with portal permissions. Accept equivalent sound approaches.'};
}));
