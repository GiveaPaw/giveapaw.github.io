// The human anatomy quiz pages, grouped by body area, for the
// human-anatomy.html hub. The menu and the region bar on each quiz come from
// HUMAN_REGIONS in tools/site_infra.py: keep the two lists in step.
window.ANATOMY_REGIONS = [
    { group: 'Whole body', regions: [
        { slug: 'human', title: 'Full Skeleton', page: 'human-anatomy-quiz.html', data: 'quiz-data-human.js', thumb: 'human-skeleton.svg',
          blurb: 'Every major bone and joint, plus a close-up of the arm.' },
    ] },
    { group: 'Head', regions: [
        { slug: 'head', title: 'Head & Neck', page: 'head-anatomy-quiz.html', data: 'quiz-data-head.js', thumb: 'anatomy/thumbs/head.jpg',
          blurb: 'Skull, face muscles, the eye, the brain and brainstem.' },
        { slug: 'ear', title: 'Ear', page: 'ear-anatomy-quiz.html', data: 'quiz-data-ear.js', thumb: 'ear-section.svg',
          blurb: 'Landmarks of the outer ear and a section through to the cochlea.' },
    ] },
    { group: 'Trunk', regions: [
        { slug: 'chest', title: 'Chest & Lungs', page: 'chest-anatomy-quiz.html', data: 'quiz-data-chest.js', thumb: 'anatomy/thumbs/chest.jpg',
          blurb: 'Rib cage, chest-wall muscles, diaphragm, airways and lungs.' },
        { slug: 'heart', title: 'Heart', page: 'heart-anatomy-quiz.html', data: 'quiz-data-heart.js', thumb: 'anatomy/thumbs/heart.jpg',
          blurb: 'The heart from the front and back, inside, and blood flow.' },
        { slug: 'organs', title: 'Abdominal Organs', page: 'organs-anatomy-quiz.html', data: 'quiz-data-organs.js', thumb: 'anatomy/thumbs/organs.jpg',
          blurb: 'The digestive tract, liver, pancreas, spleen, kidneys and bladder.' },
        { slug: 'spine', title: 'Spine & Pelvis', page: 'spine-anatomy-quiz.html', data: 'quiz-data-spine.js', thumb: 'anatomy/thumbs/spine.jpg',
          blurb: 'Vertebral column, a typical vertebra, pelvis, hip bone and femur.' },
    ] },
    { group: 'Limbs', regions: [
        { slug: 'arm', title: 'Shoulder & Arm', page: 'arm-anatomy-quiz.html', data: 'quiz-data-arm.js', thumb: 'anatomy/thumbs/arm.jpg',
          blurb: 'Scapula, humerus, shoulder and elbow joints, and arm muscles.' },
        { slug: 'hand', title: 'Hand & Forearm', page: 'hand-anatomy-quiz.html', data: 'quiz-data-hand.js', thumb: 'anatomy/thumbs/hand.jpg',
          blurb: 'Wrist and hand bones, radius and ulna, forearm and hand muscles.' },
        { slug: 'knee', title: 'Knee', page: 'knee-anatomy-quiz.html', data: 'quiz-data-knee.js', thumb: 'knee-ligaments.svg',
          blurb: 'Bones, ligaments and tendons of the knee and the thigh and calf muscles.' },
        { slug: 'foot', title: 'Foot & Ankle', page: 'foot-anatomy-quiz.html', data: 'quiz-data-foot.js', thumb: 'anatomy/thumbs/foot.jpg',
          blurb: 'Foot bones, ankle ligaments, tibia and fibula, leg and foot muscles.' },
    ] },
];
