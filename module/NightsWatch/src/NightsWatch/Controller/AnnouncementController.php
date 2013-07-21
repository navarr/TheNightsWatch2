<?php

namespace NightsWatch\Controller;

use Doctrine\Common\Collections\Criteria;
use NightsWatch\Entity\Announcement;
use NightsWatch\Entity\User;
use NightsWatch\Form\AnnouncementForm;
use NightsWatch\Mvc\Controller\ActionController;
use Zend\View\Model\ViewModel;
use Zend\Session\Container as SessionContainer;

class AnnouncementController extends ActionController
{
    public function indexAction()
    {
        $this->updateLayoutWithIdentity();

        $rank = is_null($this->getIdentityEntity()) ? 0 : $this->getIdentityEntity()->rank;

        $announcementRepo = $this->getEntityManager()
            ->getRepository('NightsWatch\Entity\Announcement');
        $criteria = Criteria::create()
            ->where(Criteria::expr()->lte('lowestReadableRank', $rank))
            ->orderBy(['id' => 'DESC'])
            ->setMaxResults(15);

        /** @var \NightsWatch\Entity\Announcement[] $announcements */
        $announcements = $announcementRepo->matching($criteria);

        return new ViewModel(['announcements' => $announcements]);
    }

    public function viewAction()
    {
        if (!$this->params('id')) {
            $this->redirect()->toRoute('home', ['controller' => 'announcement', 'action' => 'index']);
            return false;
        }

        /** @var \NightsWatch\Entity\Announcement $announcement */
        $announcement = $this->getEntityManager()
            ->getRepository('NightsWatch\Entity\Announcement')
            ->find($this->params('id'));

        $rank = is_null($this->getIdentityEntity()) ? 0 : $this->getIdentityEntity()->rank;

        if (!$announcement || $announcement->lowestReadableRank > $rank) {
            $this->redirect()->toRoute('home', ['controller' => 'announcement', 'action' => 'index']);
            return false;
        }

        return new ViewModel(['announcement' => $announcement]);
    }

    public function createAction()
    {
        $this->updateLayoutWithIdentity();

        if ($this->disallowRankLessThan(User::RANK_GENERAL)) {
            return false;
        }

        $form = new AnnouncementForm();
        if ($this->getRequest()->isPost()) {
            $form->setData($this->getRequest()->getPost());
            if ($form->isValid()) {
                $session = new SessionContainer('NightsWatch\Announcement\Create');
                $session->title = $form->get('title')->getValue();
                $session->content = $form->get('content')->getValue();
                $session->rank = $form->get('lowrank')->getValue();
                $this->redirect()->toRoute('home', ['controller' => 'announcement', 'action' => 'preview']);
                return false;
            }
        }
        return new ViewModel(['form' => $form, 'identity' => $this->getIdentityEntity()]);
    }

    public function previewAction()
    {
        $this->updateLayoutWithIdentity();

        if ($this->disallowRankLessThan(User::RANK_GENERAL)) {
            return false;
        }

        $session = new SessionContainer('NightsWatch\Announcement\Create');
        if (empty($session->title)) {
            $this->redirect()->toRoute('home', ['controller' => 'announcement', 'action' => 'create']);
            return false;
        }

        $announcement = new Announcement();
        $announcement->title = $session->title;
        $announcement->content = $session->content;
        $announcement->user = $this->getIdentityEntity();
        $announcement->timestamp = new \DateTime();
        $announcement->lowestReadableRank = $session->rank;

        if ($this->getRequest()->isPost()) {
            $this->getEntityManager()->persist($announcement);
            $this->getEntityManager()->flush();
            $this->redirect()->toRoute('id', ['controller' => 'announcement', 'id' => $announcement->id]);
        }

        return new ViewModel(['announcement' => $announcement]);
    }
}