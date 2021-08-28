/****************************************************************************
**
** Copyright (C) 2016 The Qt Company Ltd.
** Contact: https://www.qt.io/licensing/
**
** This file is part of Qt Creator.
**
** Commercial License Usage
** Licensees holding valid commercial Qt licenses may use this file in
** accordance with the commercial license agreement provided with the
** Software or, alternatively, in accordance with the terms contained in
** a written agreement between you and The Qt Company. For licensing terms
** and conditions see https://www.qt.io/terms-conditions. For further
** information use the contact form at https://www.qt.io/contact-us.
**
** GNU General Public License Usage
** Alternatively, this file may be used under the terms of the GNU
** General Public License version 3 as published by the Free Software
** Foundation with exceptions as appearing in the file LICENSE.GPL3-EXCEPT
** included in the packaging of this file. Please review the following
** information to ensure the GNU General Public License requirements will
** be met: https://www.gnu.org/licenses/gpl-3.0.html.
**
****************************************************************************/
#pragma once

#include "qmakeprojectmanager/qmakebuildconfiguration.h"

namespace ProjectExplorer {
class Target;
class Kit;
class NamedWidget;
}

namespace Ios {
namespace Internal {

class IosBuildConfiguration : public QmakeProjectManager::QmakeBuildConfiguration
{
    friend class IosBuildConfigurationFactory;
    Q_OBJECT
public:
    explicit IosBuildConfiguration(ProjectExplorer::Target *target);
    IosBuildConfiguration(ProjectExplorer::Target *target, IosBuildConfiguration *source);

    QList<ProjectExplorer::NamedWidget *> createSubConfigWidgets() override;
    QVariantMap toMap() const override;
protected:
    bool fromMap(const QVariantMap &map) override;

private:
    void onSigningSettingsChanged(bool autoManagedSigning, QString identifier);
    void updateQmakeCommand();

private:
    QString m_signingIdentifier;
    bool m_autoManagedSigning = true;
};


class IosBuildConfigurationFactory : public QmakeProjectManager::QmakeBuildConfigurationFactory
{
public:
    explicit IosBuildConfigurationFactory(QObject *parent = 0);

    int priority(const ProjectExplorer::Kit *k, const QString &projectPath) const override;
    int priority(const ProjectExplorer::Target *parent) const override;

    ProjectExplorer::BuildConfiguration *create(ProjectExplorer::Target *parent, const ProjectExplorer::BuildInfo *info) const override;
    ProjectExplorer::BuildConfiguration *clone(ProjectExplorer::Target *parent, ProjectExplorer::BuildConfiguration *source) override;
    ProjectExplorer::BuildConfiguration *restore(ProjectExplorer::Target *parent, const QVariantMap &map) override;
};

} // namespace Internal
} // namespace Ios
